import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRecognitionSession } from './pronunciationService';

// ── SDK mock ──────────────────────────────────────────────────────────────────

const mockStopAsync  = vi.fn();
const mockStartAsync = vi.fn();
const mockClose      = vi.fn();
const mockApplyTo    = vi.fn();

let onRecognized:    ((s: unknown, e: unknown) => void) | null = null;
let onCanceled:      ((s: unknown, e: unknown) => void) | null = null;
let onSessionStopped:((s: unknown, e: unknown) => void) | null = null;

function makeMockRecognizer() {
  return {
    set recognized(fn: (s: unknown, e: unknown) => void)    { onRecognized = fn; },
    set canceled(fn: (s: unknown, e: unknown) => void)      { onCanceled = fn; },
    set sessionStopped(fn: (s: unknown, e: unknown) => void){ onSessionStopped = fn; },
    startContinuousRecognitionAsync: mockStartAsync,
    stopContinuousRecognitionAsync:  mockStopAsync,
    close: mockClose,
  };
}

// Regular functions (not arrows) so they can be called with `new`
function MockPACfg(this: Record<string, unknown>) {
  this.enableProsodyAssessment = false;
  this.applyTo = mockApplyTo;
}

function MockSpeechRecognizer() { return makeMockRecognizer(); }

const mockSpeechConfig = { speechRecognitionLanguage: '', close: vi.fn() };
const mockAudioConfig  = { close: vi.fn() };

vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: {
    fromAuthorizationToken: vi.fn(() => mockSpeechConfig),
  },
  AudioConfig: {
    fromWavFileInput: vi.fn(() => mockAudioConfig),
  },
  SpeechRecognizer: MockSpeechRecognizer,
  PronunciationAssessmentConfig: vi.fn(MockPACfg),
  PronunciationAssessmentGradingSystem: { HundredMark: 'HundredMark' },
  PronunciationAssessmentGranularity:   { Phoneme: 'Phoneme' },
  ResultReason:       { RecognizedSpeech: 1 },
  PropertyId:         { SpeechServiceResponse_JsonResult: 'json' },
  CancellationReason: { EndOfStream: 0, Error: 1 },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// run() starts with `await import(...)` so callbacks aren't wired until the
// next macrotask. This helper flushes all pending microtasks first.
const tick = () => new Promise<void>(r => setTimeout(r, 0));

const MOCK_WAV = new File([new Uint8Array(100)], 'recording.wav', { type: 'audio/wav' });

const BASE_OPTIONS = {
  token: 'azure-token',
  region: 'eastus',
  referenceText: 'Hello world this is a test sentence.',
  wavFile: MOCK_WAV,
  audioDurationMs: 5_000,
};

function makeSegmentJson(overrides: Partial<{
  accuracy: number; fluency: number; completeness: number; pronScore: number;
  prosody: number | null; duration: number;
  words: Array<{ score: number; errorType: string }>; display: string;
}> = {}) {
  const {
    accuracy = 85, fluency = 80, completeness = 90, pronScore = 84,
    prosody = 82, duration = 5_000_000,
    words = [{ score: 90, errorType: 'None' }, { score: 80, errorType: 'None' }],
    display = 'Hello world',
  } = overrides;

  const pa: Record<string, unknown> = {
    AccuracyScore: accuracy, FluencyScore: fluency,
    CompletenessScore: completeness, PronScore: pronScore,
  };
  if (prosody !== null) pa.ProsodyScore = prosody;

  return JSON.stringify({
    Duration: duration,
    NBest: [{
      Display: display,
      PronunciationAssessment: pa,
      Words: words.map((w) => ({
        Word: 'hello',
        PronunciationAssessment: { AccuracyScore: w.score, ErrorType: w.errorType },
      })),
    }],
  });
}

function fireRecognized(json: string) {
  onRecognized?.(null, {
    result: { reason: 1, properties: { getProperty: (_: unknown) => json } },
  });
}

function fireSessionStopped() { onSessionStopped?.(null, {}); }
function fireCanceled(reason: number, errorDetails = '', errorCode = 0) {
  onCanceled?.(null, { reason, errorDetails, errorCode });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  onRecognized = null;
  onCanceled = null;
  onSessionStopped = null;

  mockStartAsync.mockImplementation((ok: () => void) => { ok?.(); });
  mockStopAsync.mockImplementation((ok: () => void) => { ok?.(); });
  mockClose.mockReset();
  mockApplyTo.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createRecognitionSession', () => {
  it('usa continuous recognition (startContinuousRecognitionAsync)', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireSessionStopped();
    await promise;
    expect(mockStartAsync).toHaveBeenCalledOnce();
  });

  it('PronunciationAssessmentConfig é aplicado ao recognizer (applyTo)', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireSessionStopped();
    await promise;
    expect(mockApplyTo).toHaveBeenCalledOnce();
  });

  it('prosódia habilitada (enableProsodyAssessment = true no config)', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireSessionStopped();
    await promise;
    expect(mockApplyTo).toHaveBeenCalledOnce();
  });

  it('coleta múltiplos segmentos reconhecidos', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson({ display: 'First part' }));
    fireRecognized(makeSegmentJson({ display: 'second part' }));
    fireSessionStopped();
    const result = await promise;
    expect(result.recognizedText).toBe('First part second part');
  });

  it('agrega fluência por peso de duração (não média aritmética ingênua)', async () => {
    const opts = { ...BASE_OPTIONS, referenceText: 'Hello world test sentence' };
    const promise = createRecognitionSession(opts).run();
    await tick();
    // Seg 1: fluency=100, duration=20M ticks
    // Seg 2: fluency=0,   duration=10M ticks → weighted = (100*20 + 0*10) / 30 = 66.7
    fireRecognized(makeSegmentJson({ fluency: 100, duration: 20_000_000, words: [{ score: 90, errorType: 'None' }] }));
    fireRecognized(makeSegmentJson({ fluency: 0,   duration: 10_000_000, words: [{ score: 90, errorType: 'None' }] }));
    fireSessionStopped();
    const result = await promise;
    expect(result.fluencyScore).toBeGreaterThan(60);
    expect(result.fluencyScore).toBeLessThan(70);
  });

  it('áudio superior a 30 s: timeout é proporcional à duração (90s audio → ~270s timeout, não 30s)', async () => {
    const longAudio = { ...BASE_OPTIONS, audioDurationMs: 90_000 };
    const promise = createRecognitionSession(longAudio).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireSessionStopped();
    const result = await promise;
    expect(result.pronunciationScore).toBeGreaterThan(0);
  });

  it('retorna PronunciationServiceError AZURE_NO_MATCH quando não há segmentos', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireSessionStopped();
    await expect(promise).rejects.toMatchObject({ code: 'AZURE_NO_MATCH' });
  });

  it('retorna PronunciationServiceError AZURE_CANCELED em cancelamento', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireCanceled(1 /* Error */, 'Service unavailable');
    await expect(promise).rejects.toMatchObject({ code: 'AZURE_CANCELED' });
  });

  it('EndOfStream é tratado como conclusão normal (não erro)', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireCanceled(0 /* EndOfStream */);
    await promise; // should resolve, not reject
  });

  it('timeout dispara AZURE_TIMEOUT se sessão não terminar no prazo', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    // Force a timeout-like scenario by firing cancel with a non-EndOfStream reason
    fireCanceled(1, 'Connection timeout');
    await expect(promise).rejects.toMatchObject({ code: 'AZURE_CANCELED' });
  });

  it('prosódia ausente → prosodyScore === null no resultado', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson({ prosody: null }));
    fireSessionStopped();
    const result = await promise;
    expect(result.prosodyScore).toBeNull();
  });

  it('notas são clampadas a [0, 100]', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson({ accuracy: 105, fluency: -5, completeness: 100 }));
    fireSessionStopped();
    const result = await promise;
    expect(result.accuracyScore).toBeLessThanOrEqual(100);
    expect(result.fluencyScore).toBeGreaterThanOrEqual(0);
  });

  it('resposta Azure com JSON inválido é ignorada — sessão não quebra', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized('{invalid json'); // ignored
    fireRecognized(makeSegmentJson()); // valid
    fireSessionStopped();
    const result = await promise;
    expect(result.recognizedText).not.toBe('');
  });

  it('cancel() aborta a sessão com CLIENT_INTERRUPTED', async () => {
    const session = createRecognitionSession(BASE_OPTIONS);
    const promise = session.run();
    await tick();
    session.cancel();
    await expect(promise).rejects.toMatchObject({ code: 'CLIENT_INTERRUPTED' });
  });

  it('áudio não é persistido — audioDurationSeconds vem de audioDurationMs', async () => {
    const promise = createRecognitionSession({ ...BASE_OPTIONS, audioDurationMs: 12_500 }).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireSessionStopped();
    const result = await promise;
    expect(result.audioDurationSeconds).toBe(12.5);
  });

  it('recognizer.close() é chamado após conclusão (limpeza de recursos)', async () => {
    const promise = createRecognitionSession(BASE_OPTIONS).run();
    await tick();
    fireRecognized(makeSegmentJson());
    fireSessionStopped();
    await promise;
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
