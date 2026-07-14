export type AudioConversionErrorCode = 'AUDIO_EMPTY' | 'AUDIO_DECODE_FAILED';

export class AudioConversionError extends Error {
  constructor(
    public readonly code: AudioConversionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AudioConversionError';
  }
}

const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Converts any browser-recorded Blob (webm/opus, mp4, etc.) to a WAV file
 * suitable for Azure Speech: mono, 16 kHz, 16-bit PCM, little-endian, RIFF/WAVE header.
 *
 * Uses AudioContext.decodeAudioData + OfflineAudioContext for resampling/mono mixdown.
 * The browser's own decoding pipeline handles any codec the MediaRecorder produced,
 * so there is no dependency on ffmpeg or any third-party codec library.
 *
 * Throws AudioConversionError with code AUDIO_EMPTY or AUDIO_DECODE_FAILED.
 */
export async function convertToWavPcm(blob: Blob): Promise<File> {
  if (!blob || blob.size === 0) {
    throw new AudioConversionError('AUDIO_EMPTY', 'O blob de áudio está vazio.');
  }

  const arrayBuffer = await blob.arrayBuffer();

  // decodeAudioData is the browser's universal codec gateway
  let sourceBuffer: AudioBuffer;
  const ctx = new AudioContext();
  try {
    sourceBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new AudioConversionError(
      'AUDIO_DECODE_FAILED',
      'Não foi possível decodificar o áudio gravado. Tente gravar novamente.',
    );
  } finally {
    ctx.close().catch(() => undefined);
  }

  // OfflineAudioContext resamples + mixes down to mono at 16 kHz in one pass
  const numOutputSamples = Math.ceil(sourceBuffer.duration * TARGET_SAMPLE_RATE);
  const offline = new OfflineAudioContext(TARGET_CHANNELS, numOutputSamples, TARGET_SAMPLE_RATE);

  const source = offline.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0); // Float32Array, mono

  const wavBuffer = encodeWav(samples, TARGET_SAMPLE_RATE);
  return new File([wavBuffer], 'recording.wav', { type: 'audio/wav' });
}

// ── WAV encoding ──────────────────────────────────────────────────────────────

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2; // 16-bit = 2 bytes per sample
  const totalBytes = 44 + dataBytes;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  const int16 = new Int16Array(buffer, 44);

  // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalBytes - 8, true);
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                               // sub-chunk size (PCM = 16)
  view.setUint16(20, 1, true);                                // audio format: PCM = 1
  view.setUint16(22, TARGET_CHANNELS, true);                  // num channels
  view.setUint32(24, sampleRate, true);                       // sample rate
  view.setUint32(28, sampleRate * TARGET_CHANNELS * (BITS_PER_SAMPLE / 8), true); // byte rate
  view.setUint16(32, TARGET_CHANNELS * (BITS_PER_SAMPLE / 8), true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);                  // bits per sample

  // data sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
