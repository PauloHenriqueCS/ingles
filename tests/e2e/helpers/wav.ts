/**
 * Generates a minimal valid WAV file (PCM 16-bit, mono, 16 kHz).
 * Contains a 440 Hz sine wave so it is audible — not silence.
 * Azure Speech SDK rejects completely silent audio, so a tone is necessary.
 *
 * Layout:
 *   RIFF header (4 + 4 + 4 = 12 bytes)
 *   fmt  chunk  (4 + 4 + 16 = 24 bytes)
 *   data chunk  (4 + 4 + N  bytes)
 */
export function buildTestWav(durationSeconds = 2): Buffer {
  const sampleRate    = 16_000;
  const numChannels   = 1;
  const bitsPerSample = 16;
  const numSamples    = sampleRate * durationSeconds;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes      = numSamples * numChannels * bytesPerSample;

  const buffer = Buffer.alloc(44 + dataBytes);
  let offset = 0;

  // RIFF header
  buffer.write('RIFF',          offset); offset += 4;
  buffer.writeUInt32LE(36 + dataBytes, offset); offset += 4;
  buffer.write('WAVE',          offset); offset += 4;

  // fmt chunk
  buffer.write('fmt ',          offset); offset += 4;
  buffer.writeUInt32LE(16,      offset); offset += 4; // chunk size
  buffer.writeUInt16LE(1,       offset); offset += 2; // PCM
  buffer.writeUInt16LE(numChannels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate,  offset); offset += 4;
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, offset); offset += 4;
  buffer.writeUInt16LE(numChannels * bytesPerSample, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data chunk header
  buffer.write('data',          offset); offset += 4;
  buffer.writeUInt32LE(dataBytes,    offset); offset += 4;

  // 440 Hz sine wave samples
  const freq      = 440;
  const amplitude = 0.3 * 32767;
  for (let i = 0; i < numSamples; i++) {
    const t      = i / sampleRate;
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t));
    buffer.writeInt16LE(sample, offset);
    offset += 2;
  }

  return buffer;
}

/** Path where the WAV fixture is written for use with --use-file-for-fake-audio-capture */
import path from 'path';
export const WAV_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/test-audio.wav');
