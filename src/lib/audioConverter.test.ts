import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { convertToWavPcm, AudioConversionError } from './audioConverter';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PCM_SAMPLES = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);

function makeAudioBuffer(channels = 1, sampleRate = 44100, samples = PCM_SAMPLES): AudioBuffer {
  return {
    numberOfChannels: channels,
    sampleRate,
    duration: samples.length / sampleRate,
    length: samples.length,
    getChannelData: () => samples,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function makeRenderedBuffer(samples = PCM_SAMPLES): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate: 16_000,
    duration: samples.length / 16_000,
    length: samples.length,
    getChannelData: () => samples,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function makeBlob(size = 1024, type = 'audio/webm'): Blob {
  return new Blob([new Uint8Array(size).fill(0)], { type });
}

function setupAudioContextMock(opts: { decodeOk?: boolean } = {}) {
  const { decodeOk = true } = opts;
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockDecode = decodeOk
    ? vi.fn().mockResolvedValue(makeAudioBuffer())
    : vi.fn().mockRejectedValue(new Error('decode error'));
  const mockStartRendering = vi.fn().mockResolvedValue(makeRenderedBuffer());
  const mockBufferSource = {
    buffer: null as unknown,
    connect: vi.fn(),
    start: vi.fn(),
  };

  vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function() {
    return {
      close: mockClose,
      decodeAudioData: mockDecode,
      createBufferSource: vi.fn().mockReturnValue(mockBufferSource),
    };
  }));

  vi.stubGlobal('OfflineAudioContext', vi.fn().mockImplementation(function() {
    return {
      createBufferSource: vi.fn().mockReturnValue(mockBufferSource),
      destination: {},
      startRendering: mockStartRendering,
    };
  }));

  return { mockDecode, mockStartRendering, mockClose };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('convertToWavPcm', () => {
  beforeEach(() => {
    vi.stubGlobal('File', class MockFile {
      constructor(public parts: BlobPart[], public name: string, public opts: FilePropertyBag) {}
      get type() { return this.opts.type ?? ''; }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lança AUDIO_EMPTY para Blob vazio', async () => {
    const blob = new Blob([]);
    await expect(convertToWavPcm(blob)).rejects.toMatchObject({
      code: 'AUDIO_EMPTY',
    });
  });

  it('lança AUDIO_EMPTY quando blob.size === 0', async () => {
    const blob = { size: 0, arrayBuffer: vi.fn() } as unknown as Blob;
    await expect(convertToWavPcm(blob)).rejects.toBeInstanceOf(AudioConversionError);
  });

  it('lança AUDIO_DECODE_FAILED quando decodeAudioData falha (webm)', async () => {
    setupAudioContextMock({ decodeOk: false });
    await expect(convertToWavPcm(makeBlob(512, 'audio/webm'))).rejects.toMatchObject({
      code: 'AUDIO_DECODE_FAILED',
    });
  });

  it('lança AUDIO_DECODE_FAILED quando decodeAudioData falha (mp4/Safari)', async () => {
    setupAudioContextMock({ decodeOk: false });
    await expect(convertToWavPcm(makeBlob(512, 'audio/mp4'))).rejects.toMatchObject({
      code: 'AUDIO_DECODE_FAILED',
    });
  });

  it('converte webm para WAV e retorna File com type audio/wav', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    expect((result as unknown as { type: string }).type).toBe('audio/wav');
    expect((result as unknown as { name: string }).name).toBe('recording.wav');
  });

  it('cabeçalho RIFF/WAVE válido: 4 bytes iniciais são RIFF', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const buf = parts[0] as ArrayBuffer;
    const bytes = new Uint8Array(buf, 0, 4);
    const riff = String.fromCharCode(...bytes);
    expect(riff).toBe('RIFF');
  });

  it('cabeçalho: WAVE marker nos bytes 8-12', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const buf = parts[0] as ArrayBuffer;
    const bytes = new Uint8Array(buf, 8, 4);
    expect(String.fromCharCode(...bytes)).toBe('WAVE');
  });

  it('cabeçalho: audio format PCM = 1 (bytes 20-22)', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const view = new DataView(parts[0] as ArrayBuffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
  });

  it('cabeçalho: 1 canal (mono)', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const view = new DataView(parts[0] as ArrayBuffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
  });

  it('cabeçalho: sample rate = 16000 Hz', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const view = new DataView(parts[0] as ArrayBuffer);
    expect(view.getUint32(24, true)).toBe(16_000);
  });

  it('cabeçalho: bits per sample = 16', async () => {
    setupAudioContextMock();
    const result = await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const view = new DataView(parts[0] as ArrayBuffer);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('OfflineAudioContext é criado com sample rate 16000', async () => {
    setupAudioContextMock();
    await convertToWavPcm(makeBlob(1024, 'audio/webm'));
    const offlineCtorArgs = (vi.mocked(OfflineAudioContext as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as unknown[]);
    // OfflineAudioContext(channels, length, sampleRate) — sampleRate é o 3º arg
    expect(offlineCtorArgs[2]).toBe(16_000);
    expect(offlineCtorArgs[0]).toBe(1); // mono
  });

  it('converte amostras Float32 [-1,1] corretamente para Int16', async () => {
    // Use amostras conhecidas para verificar a conversão
    const knownSamples = new Float32Array([0, 1, -1, 0.5, -0.5]);
    const renderedBuf = makeRenderedBuffer(knownSamples);
    vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function() {
      return {
        close: vi.fn().mockResolvedValue(undefined),
        decodeAudioData: vi.fn().mockResolvedValue(makeAudioBuffer()),
      };
    }));
    vi.stubGlobal('OfflineAudioContext', vi.fn().mockImplementation(function() {
      return {
        createBufferSource: vi.fn().mockReturnValue({ buffer: null, connect: vi.fn(), start: vi.fn() }),
        destination: {},
        startRendering: vi.fn().mockResolvedValue(renderedBuf),
      };
    }));

    const result = await convertToWavPcm(makeBlob(1024));
    const parts = (result as unknown as { parts: BlobPart[] }).parts;
    const view = new DataView(parts[0] as ArrayBuffer);
    // offset 44 = start of PCM data
    const sample0 = view.getInt16(44, true); // 0.0 → 0
    const sample1 = view.getInt16(46, true); // 1.0 → 32767
    const sample2 = view.getInt16(48, true); // -1.0 → -32768
    expect(sample0).toBe(0);
    expect(sample1).toBe(0x7fff);
    expect(sample2).toBe(-0x8000);
  });
});
