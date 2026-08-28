/**
 * pronunciation-server-assessment.test.ts
 *
 * Covers api/_azure-pronunciation.ts — the server-side continuous pronunciation
 * assessment that replaced the browser-side Azure Speech WebSocket leg.
 *
 * The bug being regressed against: in the browser the SDK could emit ZERO events
 * (no recognized / canceled / sessionStopped) and hang until the app's blanket
 * timer fired, so every failure looked like "A análise demorou demais". These
 * tests pin that (a) a degenerate recording is rejected BEFORE Azure is touched,
 * (b) a silent provider is caught by the no-progress watchdog with a specific
 * code, and (c) the scores are byte-identical to what the browser produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Speech SDK mock ───────────────────────────────────────────────────────────

let onRecognized:     ((s: unknown, e: unknown) => void) | null = null;
let onRecognizing:    ((s: unknown, e: unknown) => void) | null = null;
let onCanceled:       ((s: unknown, e: unknown) => void) | null = null;
let onSessionStopped: ((s: unknown, e: unknown) => void) | null = null;
let onSessionStarted: ((s: unknown, e: unknown) => void) | null = null;

// vi.mock factories are hoisted above every top-level const, so the spies they
// close over have to come from vi.hoisted().
const {
  mockStartAsync, mockStopAsync, mockClose, mockApplyTo, mockFromWavFileInput,
} = vi.hoisted(() => ({
  mockStartAsync: vi.fn(),
  mockStopAsync:  vi.fn(),
  mockClose:      vi.fn(),
  mockApplyTo:    vi.fn(),
  mockFromWavFileInput: vi.fn(() => ({ close: vi.fn() })),
}));

function MockSpeechRecognizer() {
  return {
    set recognized(fn: (s: unknown, e: unknown) => void)     { onRecognized = fn; },
    set recognizing(fn: (s: unknown, e: unknown) => void)    { onRecognizing = fn; },
    set canceled(fn: (s: unknown, e: unknown) => void)       { onCanceled = fn; },
    set sessionStopped(fn: (s: unknown, e: unknown) => void) { onSessionStopped = fn; },
    set sessionStarted(fn: (s: unknown, e: unknown) => void) { onSessionStarted = fn; },
    startContinuousRecognitionAsync: mockStartAsync,
    stopContinuousRecognitionAsync:  mockStopAsync,
    close: mockClose,
  };
}

function MockPACfg(this: Record<string, unknown>) {
  this.enableProsodyAssessment = false;
  this.applyTo = mockApplyTo;
}

vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: { fromSubscription: vi.fn(() => ({ speechRecognitionLanguage: '', close: vi.fn() })) },
  AudioConfig:  { fromWavFileInput: mockFromWavFileInput },
  SpeechRecognizer: MockSpeechRecognizer,
  PronunciationAssessmentConfig: vi.fn(MockPACfg),
  PronunciationAssessmentGradingSystem: { HundredMark: 'HundredMark' },
  PronunciationAssessmentGranularity:   { Phoneme: 'Phoneme' },
  ResultReason:       { RecognizedSpeech: 1 },
  PropertyId:         { SpeechServiceResponse_JsonResult: 'json' },
  CancellationReason: { EndOfStream: 0, Error: 1 },
}));

import { assessPronunciation, parseWavHeader } from '../_azure-pronunciation';
import { buildNormalizedResult, parseSegmentJson } from '../../src/domain/pronunciation/pronunciation-scoring';

// ── WAV helpers ───────────────────────────────────────────────────────────────

function makeWav(numSamples: number, opts: Partial<{
  sampleRate: number; channels: number; bitsPerSample: number; audioFormat: number; junkChunk: boolean;
}> = {}): Buffer {
  const { sampleRate = 16_000, channels = 1, bitsPerSample = 16, audioFormat = 1, junkChunk = false } = opts;
  const dataBytes = numSamples * (bitsPerSample / 8) * channels;
  const junkSize = junkChunk ? 8 + 16 : 0;
  const buf = Buffer.alloc(44 + junkSize + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WAVE', 8, 'ascii');

  let pos = 12;
  if (junkChunk) {
    buf.write('JUNK', pos, 'ascii');
    buf.writeUInt32LE(16, pos + 4);
    pos += 24;
  }
  buf.write('fmt ', pos, 'ascii');
  buf.writeUInt32LE(16, pos + 4);
  buf.writeUInt16LE(audioFormat, pos + 8);
  buf.writeUInt16LE(channels, pos + 10);
  buf.writeUInt32LE(sampleRate, pos + 12);
  buf.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), pos + 16);
  buf.writeUInt16LE(channels * (bitsPerSample / 8), pos + 20);
  buf.writeUInt16LE(bitsPerSample, pos + 22);
  pos += 24;

  buf.write('data', pos, 'ascii');
  buf.writeUInt32LE(dataBytes, pos + 4);
  return buf;
}

/** 3 s of 16 kHz mono — comfortably above every validation floor. */
const GOOD_WAV = makeWav(48_000);

function segmentJson(overrides: Partial<{ accuracy: number; fluency: number; completeness: number; prosody: number | null; duration: number; display: string; words: Array<{ score: number; errorType: string }> }> = {}) {
  const {
    accuracy = 85, fluency = 80, completeness = 90, prosody = 82,
    duration = 30_000_000, display = 'hello world',
    words = [{ score: 90, errorType: 'None' }, { score: 80, errorType: 'None' }],
  } = overrides;
  const pa: Record<string, unknown> = {
    AccuracyScore: accuracy, FluencyScore: fluency, CompletenessScore: completeness, PronScore: 84,
  };
  if (prosody !== null) pa.ProsodyScore = prosody;
  return JSON.stringify({
    Duration: duration,
    NBest: [{
      Display: display,
      PronunciationAssessment: pa,
      Words: words.map((w) => ({
        Word: 'hello',
        PronunciationAssessment: {
          AccuracyScore: w.score, ErrorType: w.errorType,
          Phonemes: [{ Phoneme: 'h', PronunciationAssessment: { AccuracyScore: w.score } }],
        },
      })),
    }],
  });
}

function fireRecognized(json: string) {
  onRecognized?.(null, { result: { reason: 1, properties: { getProperty: () => json } } });
}
function fireCanceled(reason: number, errorDetails = '', errorCode = 0) {
  onCanceled?.(null, { reason, errorDetails, errorCode });
}

const REFERENCE_TEXT = 'Hello world this is a test sentence.';

beforeEach(() => {
  onRecognized = onRecognizing = onCanceled = onSessionStopped = onSessionStarted = null;
  vi.clearAllMocks();
  mockStartAsync.mockImplementation((ok: () => void) => { ok?.(); });
  mockStopAsync.mockImplementation((ok: () => void) => { ok?.(); });
  mockFromWavFileInput.mockImplementation(() => ({ close: vi.fn() }));
  process.env.AZURE_SPEECH_KEY = 'test-key';
  process.env.AZURE_SPEECH_REGION = 'eastus';
});

afterEach(() => {
  vi.useRealTimers();
});

// ── WAV validation ────────────────────────────────────────────────────────────

describe('parseWavHeader', () => {
  it('parses a valid 16 kHz mono 16-bit WAV and derives the duration from the bytes', () => {
    const info = parseWavHeader(GOOD_WAV);
    expect(info.sampleRate).toBe(16_000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.dataBytes).toBe(96_000);
    expect(info.durationMs).toBe(3_000);
  });

  it('tolerates a JUNK chunk before fmt (files other encoders emit)', () => {
    const info = parseWavHeader(makeWav(48_000, { junkChunk: true }));
    expect(info.durationMs).toBe(3_000);
  });

  it('rejects a header-only WAV as AUDIO_EMPTY instead of shipping silence to Azure', () => {
    expect(() => parseWavHeader(makeWav(0))).toThrow(/AUDIO_EMPTY|too small/i);
  });

  it('rejects a truncated buffer', () => {
    expect(() => parseWavHeader(GOOD_WAV.subarray(0, 40))).toThrow();
  });

  it('rejects a non-RIFF payload', () => {
    const notWav = Buffer.alloc(4096);
    notWav.write('FFFF', 0, 'ascii');
    expect(() => parseWavHeader(notWav)).toThrow(/RIFF/i);
  });

  it('rejects non-PCM, stereo and non-16-bit audio', () => {
    expect(() => parseWavHeader(makeWav(48_000, { audioFormat: 3 }))).toThrow(/PCM/i);
    expect(() => parseWavHeader(makeWav(48_000, { channels: 2 }))).toThrow(/mono/i);
    expect(() => parseWavHeader(makeWav(48_000, { bitsPerSample: 8 }))).toThrow();
  });

  it('rejects a clip too short to assess', () => {
    // 0.1 s — above the byte floor is not enough; duration must be usable.
    expect(() => parseWavHeader(makeWav(1_600))).toThrow(/too short|AUDIO_EMPTY/i);
  });
});

// ── Assessment ────────────────────────────────────────────────────────────────

describe('assessPronunciation', () => {
  it('produces a result identical to the shared scoring module (browser parity)', async () => {
    const promise = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT, language: 'en-US' });
    await new Promise((r) => setTimeout(r, 0));

    const json = segmentJson();
    fireRecognized(json);
    onSessionStopped?.(null, {});

    const { result, wav } = await promise;

    // The exact payload the browser would have produced for the same segments.
    const expected = buildNormalizedResult(
      [parseSegmentJson(json)!], [JSON.parse(json)], REFERENCE_TEXT, wav.durationMs,
    );
    expect(result).toEqual(expected);

    // Per-word data and the raw segments (which carry the phoneme detail the UI
    // renders) must survive untouched.
    expect(result.wordsJson).toEqual([
      { accuracyScore: 90, errorType: 'None' },
      { accuracyScore: 80, errorType: 'None' },
    ]);
    const raw = result.rawSegments[0] as any;
    expect(raw.NBest[0].Words[0].PronunciationAssessment.Phonemes).toHaveLength(1);
  });

  it('uses continuous recognition with Phoneme granularity, prosody on and miscue off', async () => {
    const sdk = await import('microsoft-cognitiveservices-speech-sdk');
    const promise = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    await new Promise((r) => setTimeout(r, 0));
    fireRecognized(segmentJson());
    onSessionStopped?.(null, {});
    await promise;

    expect(sdk.PronunciationAssessmentConfig).toHaveBeenCalledWith(
      REFERENCE_TEXT, 'HundredMark', 'Phoneme', false,
    );
    expect(mockStartAsync).toHaveBeenCalled();
  });

  it('derives audioDurationSeconds from the WAV bytes, not from any client claim', async () => {
    const promise = assessPronunciation({ wav: makeWav(160_000), referenceText: REFERENCE_TEXT }); // 10 s
    await new Promise((r) => setTimeout(r, 0));
    fireRecognized(segmentJson());
    onSessionStopped?.(null, {});
    const { result } = await promise;
    expect(result.audioDurationSeconds).toBe(10);
  });

  it('rejects a degenerate WAV before constructing the recognizer', async () => {
    await expect(
      assessPronunciation({ wav: makeWav(0), referenceText: REFERENCE_TEXT }),
    ).rejects.toMatchObject({ code: 'AUDIO_EMPTY' });
    // Azure must never be contacted for audio we already know is unusable.
    expect(mockFromWavFileInput).not.toHaveBeenCalled();
    expect(mockStartAsync).not.toHaveBeenCalled();
  });

  it('maps an Azure cancellation to AZURE_CANCELED', async () => {
    const promise = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    await new Promise((r) => setTimeout(r, 0));
    fireCanceled(1, 'service unavailable', 7);
    await expect(promise).rejects.toMatchObject({ code: 'AZURE_CANCELED' });
  });

  it('maps an Azure auth rejection to AZURE_AUTH_FAILED', async () => {
    const promise = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    await new Promise((r) => setTimeout(r, 0));
    fireCanceled(1, 'forbidden', 2);
    await expect(promise).rejects.toMatchObject({ code: 'AZURE_AUTH_FAILED' });
  });

  it('treats EndOfStream with no speech as AZURE_NO_MATCH', async () => {
    const promise = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    await new Promise((r) => setTimeout(r, 0));
    fireCanceled(0); // EndOfStream, zero segments collected
    await expect(promise).rejects.toMatchObject({ code: 'AZURE_NO_MATCH' });
  });

  it('a silent provider trips the no-progress watchdog instead of hanging forever', async () => {
    vi.useFakeTimers();
    const promise = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'AZURE_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(0);
    // Azure accepts the connection and then goes completely silent — exactly the
    // production failure. The idle watchdog (45 s) must fire well before the
    // overall budget, so the user gets a fast, specific failure.
    await vi.advanceTimersByTimeAsync(46_000);
    await assertion;
  });

  it('progress resets the idle watchdog so a long reading is never cut short', async () => {
    vi.useFakeTimers();
    const promise = assessPronunciation({ wav: makeWav(960_000), referenceText: REFERENCE_TEXT }); // 60 s
    await vi.advanceTimersByTimeAsync(0);

    // Keep Azure "alive" past the idle window with periodic results.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      fireRecognized(segmentJson({ display: `chunk ${i}` }));
    }
    onSessionStopped?.(null, {});
    const { result } = await promise;

    expect(result.recognizedText).toBe('chunk 0 chunk 1 chunk 2 chunk 3');
    expect(result.wordsJson).toHaveLength(8);
  });

  it('fails cleanly when Azure Speech is not configured', async () => {
    process.env.AZURE_SPEECH_KEY = '';
    await expect(
      assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT }),
    ).rejects.toThrow(/not configured/i);
  });

  it('closes the recognizer on both the success and failure paths', async () => {
    const ok = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    await new Promise((r) => setTimeout(r, 0));
    fireRecognized(segmentJson());
    onSessionStopped?.(null, {});
    await ok;
    expect(mockClose).toHaveBeenCalled();

    vi.clearAllMocks();
    mockStartAsync.mockImplementation((cb: () => void) => { cb?.(); });
    mockStopAsync.mockImplementation((cb: () => void) => { cb?.(); });
    const bad = assessPronunciation({ wav: GOOD_WAV, referenceText: REFERENCE_TEXT });
    await new Promise((r) => setTimeout(r, 0));
    fireCanceled(1, 'boom', 7);
    await bad.catch(() => undefined);
    expect(mockClose).toHaveBeenCalled();
  });
});
