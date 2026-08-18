/**
 * SERVER-ONLY: reusable Azure Speech TTS synthesis returning the audio bytes as a
 * Buffer (for persistence in the shared content library), as opposed to
 * `api/tts.ts` which STREAMS the audio back to the client with `no-store`.
 *
 * Same provider, SSML shape, gateway wiring and error taxonomy as `api/tts.ts`
 * — kept in one place so the shared-content flow and the streaming endpoint
 * never diverge on how Azure is called or metered. Never logs user text, never
 * exposes the Azure key.
 */

import { executeAiGatewayCall, getProductionDeps, estimateTtsCharacters, estimateProviderRequests } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';
import { countTtsSsmlCharacters } from './_ai-gateway/tts-character-count';

const TTS_TIMEOUT_MS = 25_000;

export class AzureTtsSynthesisError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AzureTtsSynthesisError';
    this.code = code;
    this.status = status;
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text: string, voice: string, locale: string): string {
  return (
    `<speak version="1.0" xml:lang="${locale}">` +
    `<voice name="${voice}">` +
    `<prosody rate="0%">${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

function buildTtsMetrics(characterCount: number): GatewayUsageMetric[] {
  return [
    { metricKey: 'provider_requests', unitType: 'request', quantity: 1, isBillable: false, measurementSource: 'provider_response' },
    { metricKey: 'tts_characters', unitType: 'character', quantity: characterCount, isBillable: true, measurementSource: 'ssml_request_body' },
  ];
}

export interface SynthesizeSpeechInput {
  text: string;
  /** Must already be validated by the caller (SAFE_AZURE_VOICE_RE + allowlist). */
  voice: string;
  locale: string;
  outputFormat: string;
  userId: string;
  /** Label for the gateway technicalMetadata.endpoint (observability). */
  endpoint: string;
}

export interface SynthesizedSpeech {
  audio: Buffer;
  mimeType: string;
}

/**
 * Synthesizes `text` with Azure TTS and returns the audio bytes. Throws
 * AzureTtsSynthesisError (typed code/status) on any provider failure so the
 * caller can treat the audio as best-effort (§9 — a failed TTS never yields a
 * broken audio pointer). The physical fetch is wrapped in the AI Gateway exactly
 * like `api/tts.ts` (same featureKey, metering and reservation semantics).
 */
export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizedSpeech> {
  const key = (process.env.AZURE_SPEECH_KEY ?? '').trim();
  const region = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!key || !region) {
    throw new AzureTtsSynthesisError('AZURE_SPEECH_NOT_CONFIGURED', 503, 'Azure Speech not configured');
  }

  const ssml = buildSsml(input.text, input.voice, input.locale);
  const ttsUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const characterCount = countTtsSsmlCharacters(ssml);
  const gatewayDeps = getProductionDeps();

  const audioBuffer = await executeAiGatewayCall<ArrayBuffer>(
    {
      featureKey: 'tts.synthesize',
      provider: 'azure',
      service: 'tts_rest',
      userId: input.userId,
      initiatedByUserId: input.userId,
      actorType: 'user',
      executionLocation: 'backend',
      correlationId: gatewayDeps.uuidGen(),
      attemptNumber: 1,
      callSequence: 1,
      technicalMetadata: { endpoint: input.endpoint, region, voiceName: input.voice },
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
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': input.outputFormat,
            'User-Agent': 'lemon-english-app/1.0',
          },
          body: ssml,
          signal: controller.signal,
        });
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        throw isAbort
          ? new AzureTtsSynthesisError('AZURE_TTS_TIMEOUT', 504, 'Azure TTS timed out')
          : new AzureTtsSynthesisError('AZURE_TTS_NETWORK', 503, 'Could not reach Azure TTS');
      } finally {
        clearTimeout(timer);
      }
      if (!ttsResponse.ok) {
        const status = ttsResponse.status === 429 ? 503 : ttsResponse.status >= 500 ? 503 : 400;
        throw new AzureTtsSynthesisError('AZURE_TTS_HTTP_ERROR', status, `Azure TTS returned HTTP ${ttsResponse.status}`);
      }
      const buf = await ttsResponse.arrayBuffer();
      if (!buf.byteLength) {
        throw new AzureTtsSynthesisError('AZURE_TTS_EMPTY_AUDIO', 503, 'Azure TTS returned empty audio');
      }
      return buf;
    },
    gatewayDeps,
    () => buildTtsMetrics(characterCount),
  );

  return { audio: Buffer.from(audioBuffer), mimeType: 'audio/mpeg' };
}
