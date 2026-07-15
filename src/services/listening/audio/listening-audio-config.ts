import type { ListeningAzureSpeechConfig } from './listening-audio-types';

// Canonical format identifier — matches Audio24Khz96KBitRateMonoMp3 in the SDK enum
export const AUDIO_OUTPUT_FORMAT_NAME = 'Audio24Khz96KBitRateMonoMp3';
// Numeric value of SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3 (SDK v1.50)
export const AUDIO_OUTPUT_FORMAT_VALUE = 38;
export const AUDIO_CONTENT_TYPE = 'audio/mpeg';
export const AUDIO_FILE_EXTENSION = '.mp3';
export const AUDIO_FORMAT_LABEL = 'mp3_24khz_96kbps_mono';

// Idempotency key: bump when synthesis approach changes in a way that produces different audio
export const SYNTHESIS_CONFIG_VERSION = 'listening-audio-v1';

// Duration window per block (approx 5 min target)
export const DURATION_MIN_MS = 4 * 60 * 1000;     // 4 min
export const DURATION_TARGET_MS = 5 * 60 * 1000;  // 5 min
export const DURATION_MAX_MS = 6 * 60 * 1000;     // 6 min
// Beyond ±30s from target → needs_review; beyond ±2min → invalid
export const DURATION_REVIEW_MARGIN_MS = 30_000;

// Minimum plausible file size for a non-trivial audio block (1 second at 96 kbps = ~12 KB)
export const AUDIO_MIN_SIZE_BYTES = 10_000;

// Private storage bucket and path prefix
export const AUDIO_STORAGE_BUCKET = 'listening-audio';
export const AUDIO_STAGING_PREFIX = 'staging';

// Synthesis timeout per block
export const SYNTHESIS_TIMEOUT_MS = 180_000; // 3 minutes

// Retry config
export const MAX_RETRIES = 2;
export const RETRY_DELAY_BASE_MS = 5_000;

// Non-retryable Azure error codes (auth, config, voice not found)
export const NON_RETRYABLE_AZURE_ERROR_CODES = new Set([
  'AuthenticationFailure',
  'BadRequest',
  'Forbidden',
  'NotFound',
]);

export function buildListeningAzureSpeechConfig(
  subscriptionKey: string,
  region: string,
  voiceName: string,
  locale: string,
): ListeningAzureSpeechConfig {
  if (!subscriptionKey) throw new Error('LISTENING_AZURE_CONFIG_ERROR: AZURE_SPEECH_KEY is required');
  if (!region) throw new Error('LISTENING_AZURE_CONFIG_ERROR: AZURE_SPEECH_REGION is required');
  if (!voiceName) throw new Error('LISTENING_AZURE_CONFIG_ERROR: voiceName is required');
  if (!locale) throw new Error('LISTENING_AZURE_CONFIG_ERROR: locale is required');

  return {
    subscriptionKey,
    region,
    voiceName,
    locale,
    outputFormatValue: AUDIO_OUTPUT_FORMAT_VALUE,
    synthesisTimeoutMs: SYNTHESIS_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    synthesisConfigVersion: SYNTHESIS_CONFIG_VERSION,
  };
}

export function buildStagingAudioPath(
  cefrLevel: string,
  episodeId: string,
  contentVersion: number,
  ssmlHash: string,
  blockOrder: 1 | 2,
): string {
  const shortHash = ssmlHash.slice(0, 8);
  const blockFile = `block-0${blockOrder}${AUDIO_FILE_EXTENSION}`;
  return `${AUDIO_STAGING_PREFIX}/${cefrLevel}/${episodeId}/v${contentVersion}/ssml-${shortHash}/${blockFile}`;
}
