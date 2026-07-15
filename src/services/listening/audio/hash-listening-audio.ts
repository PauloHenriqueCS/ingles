import { createHash } from 'node:crypto';

/**
 * Computes a SHA-256 hash of the audio buffer, returning the first 32 hex chars.
 * Used to relate the stored file back to the exact synthesized content.
 */
export function computeListeningAudioHash(audioData: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(audioData)).digest('hex').slice(0, 32);
}
