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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.TTS)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

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
    safeLog('tts', isAbort ? 'azure_timeout' : 'azure_network_error', 503, {
      chars: normalized.length,
    });
    return jsonError(
      res,
      isAbort ? 504 : 503,
      'TTS_UNAVAILABLE',
      'Não foi possível gerar o áudio agora. Tente novamente.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!ttsResponse.ok) {
    const azureStatus = ttsResponse.status;
    safeLog('tts', 'azure_error', azureStatus, { azure_status: azureStatus, chars: normalized.length });
    const status = azureStatus === 429 ? 503 : azureStatus >= 500 ? 503 : 400;
    return jsonError(res, status, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
  }

  const audioBuffer = await ttsResponse.arrayBuffer();

  if (!audioBuffer.byteLength) {
    safeLog('tts', 'empty_audio', 503, { chars: normalized.length });
    return jsonError(res, 503, 'TTS_UNAVAILABLE', 'Não foi possível gerar o áudio agora. Tente novamente.');
  }

  safeLog('tts', 'success', 200, { chars: normalized.length });

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(audioBuffer.byteLength));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end(Buffer.from(audioBuffer));
}
