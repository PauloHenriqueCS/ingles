import type { ListeningAudioDurationStatus } from './listening-audio-types';
import {
  AUDIO_MIN_SIZE_BYTES,
  DURATION_MIN_MS,
  DURATION_MAX_MS,
  DURATION_REVIEW_MARGIN_MS,
  DURATION_TARGET_MS,
} from './listening-audio-config';

export interface ListeningAudioValidationResult {
  valid: boolean;
  durationStatus: ListeningAudioDurationStatus;
  failureCode: string | null;
  details: string | null;
}

export function validateListeningAudioBuffer(
  audioData: ArrayBuffer,
  durationMs: number,
): ListeningAudioValidationResult {
  if (audioData.byteLength === 0) {
    return { valid: false, durationStatus: 'invalid', failureCode: 'LISTENING_AUDIO_EMPTY', details: 'Audio buffer is empty' };
  }
  if (audioData.byteLength < AUDIO_MIN_SIZE_BYTES) {
    return {
      valid: false,
      durationStatus: 'invalid',
      failureCode: 'LISTENING_AUDIO_INVALID_FORMAT',
      details: `Audio too small: ${audioData.byteLength} bytes (min ${AUDIO_MIN_SIZE_BYTES})`,
    };
  }

  const durationStatus = classifyDuration(durationMs);

  if (durationStatus === 'invalid') {
    return {
      valid: false,
      durationStatus,
      failureCode: 'LISTENING_AUDIO_DURATION_INVALID',
      details: `Duration ${durationMs}ms is outside acceptable range [${DURATION_MIN_MS}–${DURATION_MAX_MS}ms]`,
    };
  }

  return { valid: true, durationStatus, failureCode: null, details: null };
}

function classifyDuration(durationMs: number): ListeningAudioDurationStatus {
  if (durationMs < DURATION_MIN_MS || durationMs > DURATION_MAX_MS) return 'invalid';
  const diff = Math.abs(durationMs - DURATION_TARGET_MS);
  if (diff > DURATION_REVIEW_MARGIN_MS) return 'needs_review';
  return 'valid';
}
