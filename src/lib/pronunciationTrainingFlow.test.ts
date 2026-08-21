/**
 * pronunciationTrainingFlow.test.ts
 *
 * Regression coverage for the "Treinar pronúncia" analysis flow after the
 * assessment moved from the browser (Azure Speech WebSocket) to the server
 * (POST /api/pronunciation-training/assess).
 *
 * The scenario that motivated this: the in-browser SDK session could produce
 * ZERO events — no recognized, no canceled, no sessionStopped — so the only
 * thing that ever fired was the app's blanket "3x the recording length" timer,
 * surfacing as "A análise demorou demais" after 50–200 s. These tests pin the
 * contract that replaced it, and above all the counter rules:
 *   • a daily analysis is consumed by /start and only "spent" by a completion;
 *   • timeout / Azure error / network error / upload failure must NOT consume;
 *   • retrying the same failure must not double-consume;
 *   • success consumes exactly one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTrainingAnalysisFlow, type TrainingAnalysisState } from './pronunciationTrainingFlow';

const { MockAudioConversionError } = vi.hoisted(() => {
  class MockAudioConversionError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'AudioConversionError';
    }
  }
  return { MockAudioConversionError };
});

vi.mock('./apiAuth', () => ({
  getAuthHeader: vi.fn().mockResolvedValue({ Authorization: 'Bearer test-token' }),
}));

vi.mock('./audioConverter', () => ({
  AudioConversionError: MockAudioConversionError,
  convertToWavPcm: vi.fn(),
}));

vi.mock('./base64Audio', () => ({
  fileToBase64: vi.fn().mockResolvedValue('QkFTRTY0'),
}));

import { convertToWavPcm } from './audioConverter';
import { fileToBase64 } from './base64Audio';

const mockConvertToWavPcm = vi.mocked(convertToWavPcm);
const mockFileToBase64    = vi.mocked(fileToBase64);

const ATTEMPT_ID = '33333333-3333-3333-3333-333333333333';
const SESSION_ID = '44444444-4444-4444-4444-444444444444';
const WAV_FILE   = new File(['wav'], 'recording.wav', { type: 'audio/wav' });
const BLOB       = new Blob(['audio'], { type: 'audio/webm' });

const MOCK_RESULT = {
  pronunciationScore: 88, accuracyScore: 90, fluencyScore: 85,
  completenessScore: 92, prosodyScore: 80,
  recognizedText: 'hello world',
  wordsJson: [{ accuracyScore: 90, errorType: 'None' }],
  rawSegments: [{ NBest: [{ Display: 'hello world' }] }],
  audioDurationSeconds: 3,
};

function makeFlowRefs() {
  return {
    mountedRef:           { current: true },
    attemptIdRef:         { current: null as string | null },
    sessionIdRef:         { current: null as string | null },
    cancelRecognitionRef: { current: null as (() => void) | null },
    flowLockRef:          { current: true },
  };
}

/** Sequenced fetch stub: one entry per expected HTTP call, in order. */
function makeFetch(responses: Array<{ ok: boolean; body: unknown } | Error>) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const r = responses[call++] ?? { ok: true, body: {} };
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body) });
  });
}

const START_OK = { ok: true, body: { sessionId: SESSION_ID, attemptId: ATTEMPT_ID } };

function urlsOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[index][1] as RequestInit).body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
  mockFileToBase64.mockResolvedValue('QkFTRTY0');
});

describe('runTrainingAnalysisFlow — successful analysis', () => {
  it('uploads the WAV to /assess and never opens an Azure connection from the browser', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: true, body: { result: MOCK_RESULT, dailyCompleted: 1 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    const urls = urlsOf(fetchMock);
    expect(urls[0]).toContain('/api/pronunciation-training/start');
    expect(urls[1]).toContain('/api/pronunciation-training/assess');
    // The whole point of the fix: exactly two calls, no /complete round-trip and
    // no browser-side Azure session.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const assessBody = bodyOf(fetchMock, 1);
    expect(assessBody.sessionId).toBe(SESSION_ID);
    expect(assessBody.attemptId).toBe(ATTEMPT_ID);
    expect(assessBody.audioBase64).toBe('QkFTRTY0');
    // The client must never send the reference text — the server reads it from
    // the reserved row so the user cannot choose what they are graded against.
    expect(assessBody).not.toHaveProperty('referenceText');
  });

  it('consumes exactly one analysis and surfaces the server dailyCompleted', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: true, body: { result: MOCK_RESULT, dailyCompleted: 1 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    const final = states[states.length - 1];
    expect(final.phase).toBe('completed');
    expect(final.dailyCompleted).toBe(1);
    expect(final.result).toEqual(MOCK_RESULT);
    // No /fail — a success must never release the slot.
    expect(urlsOf(fetchMock).some((u) => u.includes('/fail'))).toBe(false);
    // IDs cleared + lock released so the user can start another round.
    expect(refs.sessionIdRef.current).toBeNull();
    expect(refs.attemptIdRef.current).toBeNull();
    expect(refs.flowLockRef.current).toBe(false);
  });

  it('preserves the full result payload, including per-word and raw segment data', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: true, body: { result: MOCK_RESULT, dailyCompleted: 2 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      makeFlowRefs(),
      (s) => states.push(s),
    );

    const final = states[states.length - 1];
    expect(final.result?.wordsJson).toEqual(MOCK_RESULT.wordsJson);
    expect(final.result?.rawSegments).toEqual(MOCK_RESULT.rawSegments);
    expect(final.result?.prosodyScore).toBe(80);
  });
});

describe('runTrainingAnalysisFlow — failures must not consume an analysis', () => {
  it('Azure error from the server fails without a /fail (server already released the slot)', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: false, body: { code: 'AZURE_CANCELED', message: 'Ocorreu um erro durante a análise. Tente novamente.' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    const final = states[states.length - 1];
    expect(final.phase).toBe('failed');
    expect(final.errorCode).toBe('AZURE_CANCELED');
    expect(final.dailyCompleted).toBeUndefined();
    // The endpoint releases the reservation itself; a second /fail would be a
    // no-op but we must not fire it and pretend the flow owns the release.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refs.flowLockRef.current).toBe(false);
  });

  it('server-side timeout surfaces the specific message and consumes nothing', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: false, body: { code: 'AZURE_TIMEOUT', message: 'O serviço de pronúncia demorou para responder. Tente novamente.' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      makeFlowRefs(),
      (s) => states.push(s),
    );

    const final = states[states.length - 1];
    expect(final.phase).toBe('failed');
    expect(final.errorCode).toBe('AZURE_TIMEOUT');
    expect(final.errorMessage).toContain('demorou para responder');
    expect(final.result).toBeUndefined();
  });

  it('network failure while uploading reports /fail so the reserved slot is released', async () => {
    const fetchMock = makeFetch([
      START_OK,
      new Error('network down'),
      { ok: true, body: { status: 'failed_retryable' } }, // the /fail call
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    expect(states[states.length - 1].phase).toBe('failed');
    const urls = urlsOf(fetchMock);
    expect(urls[2]).toContain('/api/pronunciation-training/fail');
    const failBody = bodyOf(fetchMock, 2);
    expect(failBody.code).toBe('AZURE_NETWORK_ERROR');
    expect(failBody.sessionId).toBe(SESSION_ID);
    expect(failBody.attemptId).toBe(ATTEMPT_ID);
    expect(refs.flowLockRef.current).toBe(false);
  });

  it('audio that cannot be prepared fails before /start, so no slot is ever reserved', async () => {
    mockConvertToWavPcm.mockRejectedValue(new MockAudioConversionError('AUDIO_DECODE_FAILED', 'bad audio'));
    const fetchMock = makeFetch([]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    expect(states[states.length - 1].phase).toBe('failed');
    // No /start ⇒ nothing reserved ⇒ nothing to release and nothing consumed.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refs.sessionIdRef.current).toBeNull();
    expect(refs.flowLockRef.current).toBe(false);
  });

  it('empty recording fails before /start', async () => {
    const fetchMock = makeFetch([]);
    vi.stubGlobal('fetch', fetchMock);

    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: null, audioDurationMs: 0 },
      makeFlowRefs(),
      (s) => states.push(s),
    );

    expect(states[states.length - 1].phase).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('base64 encoding failure releases the slot instead of leaving it stuck in processing', async () => {
    mockFileToBase64.mockRejectedValue(new Error('RangeError: too many arguments'));
    const fetchMock = makeFetch([
      START_OK,
      { ok: true, body: { status: 'failed_retryable' } }, // the /fail call
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      makeFlowRefs(),
      (s) => states.push(s),
    );

    expect(states[states.length - 1].phase).toBe('failed');
    expect(urlsOf(fetchMock)[1]).toContain('/api/pronunciation-training/fail');
    expect(bodyOf(fetchMock, 1).code).toBe('AZURE_NETWORK_ERROR');
  });
});

describe('runTrainingAnalysisFlow — retry idempotency', () => {
  it('retrying after a failure reserves a fresh attempt and consumes only on success', async () => {
    // Attempt 1: Azure fails server-side (slot released there).
    const failFetch = makeFetch([
      START_OK,
      { ok: false, body: { code: 'AZURE_TIMEOUT', message: 'demorou' } },
    ]);
    vi.stubGlobal('fetch', failFetch);
    const refs = makeFlowRefs();
    const first: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 }, refs, (s) => first.push(s),
    );
    expect(first[first.length - 1].phase).toBe('failed');

    // Attempt 2: a NEW attemptId, and this time it succeeds.
    const retryAttemptId = '55555555-5555-5555-5555-555555555555';
    const okFetch = makeFetch([
      { ok: true, body: { sessionId: SESSION_ID, attemptId: retryAttemptId } },
      { ok: true, body: { result: MOCK_RESULT, dailyCompleted: 1 } },
    ]);
    vi.stubGlobal('fetch', okFetch);
    refs.flowLockRef.current = true;
    const second: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: retryAttemptId, audioBlob: BLOB, audioDurationMs: 3000 }, refs, (s) => second.push(s),
    );

    const final = second[second.length - 1];
    expect(final.phase).toBe('completed');
    // Exactly one consumption across both attempts.
    expect(final.dailyCompleted).toBe(1);
    expect(bodyOf(okFetch, 1).attemptId).toBe(retryAttemptId);
  });

  it('a duplicate completed attempt is reported, not silently double-counted', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: false, body: { code: 'ASSESSMENT_ALREADY_COMPLETED', message: 'O texto de hoje já possui uma análise concluída.' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      makeFlowRefs(),
      (s) => states.push(s),
    );

    const final = states[states.length - 1];
    expect(final.phase).toBe('failed');
    expect(final.errorCode).toBe('ASSESSMENT_ALREADY_COMPLETED');
    expect(final.dailyCompleted).toBeUndefined();
  });

  it('a rejected /start (daily limit) never reaches /assess', async () => {
    const fetchMock = makeFetch([
      { ok: false, body: { code: 'DAILY_LIMIT_REACHED', message: 'Limite diário atingido.' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    expect(states[states.length - 1].errorCode).toBe('DAILY_LIMIT_REACHED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refs.sessionIdRef.current).toBeNull();
  });
});

describe('runTrainingAnalysisFlow — phase reporting', () => {
  it('walks preparing_audio → reserving → analyzing → completed', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: true, body: { result: MOCK_RESULT, dailyCompleted: 1 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      makeFlowRefs(),
      (s) => states.push(s),
    );

    expect(states.map((s) => s.phase)).toEqual([
      'preparing_audio', 'reserving', 'analyzing', 'completed',
    ]);
  });

  it('does not emit phases after unmount', async () => {
    const fetchMock = makeFetch([
      START_OK,
      { ok: true, body: { result: MOCK_RESULT, dailyCompleted: 1 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const refs = makeFlowRefs();
    refs.mountedRef.current = false;
    const states: TrainingAnalysisState[] = [];
    await runTrainingAnalysisFlow(
      { attemptId: ATTEMPT_ID, audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      (s) => states.push(s),
    );

    expect(states).toHaveLength(0);
  });
});
