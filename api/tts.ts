/**
 * SERVER-ONLY: POST /api/tts
 *
 * Receives a text payload, synthesizes it using Azure Speech TTS,
 * and streams the audio binary back to the caller.
 *
 * Never logs user text, never exposes the Azure key.
 */

import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, safeLog, jsonError, PAYLOAD_LIMITS } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps, estimateTtsCharacters, estimateProviderRequests } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';
import { countTtsSsmlCharacters } from './_ai-gateway/tts-character-count';

// ── Voice configuration ───────────────────────────────────────────────────────

export const DEFAULT_ENGLISH_VOICE = 'en-US-AvaMultilingualNeural';

const ALLOWED_VOICES = new Set([
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
  'en-US-JennyNeural',
  'en-US-GuyNeural',
]);

const TTS_MAX_CHARS = 4_500;
const TTS_TIMEOUT_MS = 25_000;

// ── SSML helpers ──────────────────────────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text: string, voice: string): string {
  return (
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="${voice}">` +
    `<prosody rate="0%">${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

// ── Azure config ──────────────────────────────────────────────────────────────

function getAzureConfig(): { key: string; region: string } {
  const key = (process.env.AZURE_SPEECH_KEY ?? '').trim();
  const region = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!key || !region) {
    throw new Error('AZURE_SPEECH_NOT_CONFIGURED');
  }
  return { key, region };
}

// ── Gateway wiring — wraps only the physical Azure fetch call ─────────────────

class AzureTtsHttpError extends Error {
  constructor(public readonly azureStatus: number) {
    super(`Azure TTS returned HTTP ${azureStatus}`);
    this.name = 'AzureTtsHttpError';
  }
}
class AzureTtsTimeoutError extends Error {
  constructor() {
    super('Azure TTS request timed out');
    this.name = 'AzureTtsTimeoutError';
  }
}
class AzureTtsNetworkError extends Error {
  constructor() {
    super('Could not reach Azure TTS');
    this.name = 'AzureTtsNetworkError';
  }
}
class AzureTtsEmptyAudioError extends Error {
  constructor() {
    super('Azure TTS returned empty audio');
    this.name = 'AzureTtsEmptyAudioError';
  }
}

function buildTtsMetrics(characterCount: number): GatewayUsageMetric[] {
  return [
    {
      metricKey: 'provider_requests',
      unitType: 'request',
      quantity: 1,
      isBillable: false,
      measurementSource: 'provider_response',
    },
    {
      metricKey: 'tts_characters',
      unitType: 'character',
      quantity: characterCount,
      isBillable: true,
      // Deterministic count of the actual SSML body sent, per Microsoft's
      // documented billing rule (see tts-character-count.ts) — not an
      // estimate, but computed from the request rather than confirmed by
      // Azure's response (Azure's TTS REST response carries no usage field).
      measurementSource: 'ssml_request_body',
    },
  ];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.TTS)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!await applyRateLimit(res, auth.userId, 'tts')) return;

  // ── Input validation ───────────────────────────────────────────────────────

  const { text, voice } = req.body ?? {};
  const resolvedVoice =
    typeof voice === 'string' && ALLOWED_VOICES.has(voice) ? voice : DEFAULT_ENGLISH_VOICE;

  if (!text || typeof text !== 'string') {
    return jsonError(res, 400, 'INVALID_REQUEST', 'O campo text é obrigatório.');
  }

  const normalized = text.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'O texto não pode estar vazio.');
  }

  if (normalized.length > TTS_MAX_CHARS) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'O texto é muito longo para síntese de voz.');
  }

  // ── Azure availability check ───────────────────────────────────────────────

  let config: { key: string; region: string };
  try {
    config = getAzureConfig();
  } catch {
    safeLog('tts', 'not_configured', 503);
    return jsonError(res, 503, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
  }

  // ── Call Azure TTS REST API ────────────────────────────────────────────────

  const ssml = buildSsml(normalized, resolvedVoice);
  const ttsUrl = `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const characterCount = countTtsSsmlCharacters(ssml);

  const gatewayDeps = getProductionDeps();
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await executeAiGatewayCall<ArrayBuffer>(
      {
        featureKey: 'tts.synthesize',
        provider: 'azure',
        service: 'tts_rest',
        userId: auth.userId,
        initiatedByUserId: auth.userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'tts',
          region: config.region,
          voiceName: resolvedVoice,
        },
        // Etapa 11 correction — the exact SSML is already built above, so
        // this is an exact count (the same counter buildTtsMetrics() below
        // uses for the real tts_characters metric), not a guess. A missing
        // Azure price (confirmed: 0 provider_pricing rows for azure) blocks
        // only USD budget enforcement — this reservation still protects the
        // per-unit character quota regardless of price.
        estimatedMetrics: [estimateProviderRequests(1), estimateTtsCharacters(ssml, true)],
      },
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
        let ttsResponse: Response;
        try {
          ttsResponse = await fetch(ttsUrl, {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': config.key,
              'Content-Type': 'application/ssml+xml',
              'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
              'User-Agent': 'lemon-english-app/1.0',
            },
            body: ssml,
            signal: controller.signal,
          });
        } catch (err) {
          const isAbort = err instanceof Error && err.name === 'AbortError';
          throw isAbort ? new AzureTtsTimeoutError() : new AzureTtsNetworkError();
        } finally {
          clearTimeout(timer);
        }

        if (!ttsResponse.ok) {
          throw new AzureTtsHttpError(ttsResponse.status);
        }

        const buf = await ttsResponse.arrayBuffer();
        if (!buf.byteLength) {
          throw new AzureTtsEmptyAudioError();
        }
        return buf;
      },
      gatewayDeps,
      () => buildTtsMetrics(characterCount),
    );
  } catch (err) {
    if (err instanceof AzureTtsTimeoutError) {
      safeLog('tts', 'azure_timeout', 503, { chars: normalized.length });
      return jsonError(res, 504, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
    }
    if (err instanceof AzureTtsNetworkError) {
      safeLog('tts', 'azure_network_error', 503, { chars: normalized.length });
      return jsonError(res, 503, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
    }
    if (err instanceof AzureTtsHttpError) {
      safeLog('tts', 'azure_error', err.azureStatus, { azure_status: err.azureStatus, chars: normalized.length });
      const status = err.azureStatus === 429 ? 503 : err.azureStatus >= 500 ? 503 : 400;
      return jsonError(res, status, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
    }
    if (err instanceof AzureTtsEmptyAudioError) {
      safeLog('tts', 'empty_audio', 503, { chars: normalized.length });
      return jsonError(res, 503, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
    }
    throw err;
  }

  safeLog('tts', 'success', 200, { chars: normalized.length });

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(audioBuffer.byteLength));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end(Buffer.from(audioBuffer));
}
