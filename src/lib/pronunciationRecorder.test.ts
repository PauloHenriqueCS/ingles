/**
 * pronunciationRecorder.test.ts
 *
 * 37 test scenarios for the two extracted recorder lib modules:
 *   Group A (1-15): fetchPronunciationStatus
 *   Group B (16-37): runAnalysisFlow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchPronunciationStatus, PronunciationStatusError } from './pronunciationStatusFetcher';
import { runAnalysisFlow, type AnalysisState } from './pronunciationFlow';

// ── Module mocks ─────────────────────────────────────────────────────────────
//
// vi.mock factories are hoisted to the top of the file by vitest.
// Classes defined with `class` are NOT hoisted, so they can't be referenced
// directly inside vi.mock factories. vi.hoisted() runs before the factories and
// makes values available to them.

const { MockAudioConversionError, MockPronunciationServiceError } = vi.hoisted(() => {
  class MockAudioConversionError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'AudioConversionError';
    }
  }
  class MockPronunciationServiceError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'PronunciationServiceError';
    }
  }
  return { MockAudioConversionError, MockPronunciationServiceError };
});

vi.mock('./apiAuth', () => ({
  getAuthHeader: vi.fn().mockResolvedValue({ Authorization: 'Bearer test-token' }),
}));

vi.mock('./audioConverter', () => ({
  AudioConversionError: MockAudioConversionError,
  convertToWavPcm: vi.fn(),
}));

vi.mock('./pronunciationService', () => ({
  PronunciationServiceError: MockPronunciationServiceError,
  createRecognitionSession: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { getAuthHeader } from './apiAuth';
import { convertToWavPcm } from './audioConverter';
import { createRecognitionSession } from './pronunciationService';

const mockGetAuthHeader     = vi.mocked(getAuthHeader);
const mockConvertToWavPcm   = vi.mocked(convertToWavPcm);
const mockCreateSession     = vi.mocked(createRecognitionSession);

const REVIEW_ID = '11111111-1111-1111-1111-111111111111';
const WAV_FILE  = new File(['wav'], 'audio.wav', { type: 'audio/wav' });
const BLOB      = new Blob(['audio'], { type: 'audio/webm' });

const MOCK_RESULT = {
  pronunciationScore:   88,
  accuracyScore:        90,
  fluencyScore:         85,
  completenessScore:    92,
  prosodyScore:         80,
  recognizedText:       'hello world',
  wordsJson:            [],
  rawSegments:          [],
  audioDurationSeconds: 3,
};

function makeStartResponse(overrides = {}) {
  return {
    assessmentId: 'aaaa-1111',
    token:        'azure-token-secret',
    region:       'eastus',
    referenceText: 'hello world',
    ...overrides,
  };
}

function makeFlowRefs() {
  return {
    mountedRef:           { current: true },
    idempotencyKeyRef:    { current: null as string | null },
    assessmentIdRef:      { current: null as string | null },
    cancelRecognitionRef: { current: null as (() => void) | null },
    flowLockRef:          { current: true }, // locked by handleConfirm before calling flow
  };
}

function makeFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let call = 0;
  return vi.fn().mockImplementation(function() {
    const r = responses[call++] ?? { ok: true, body: {} };
    return Promise.resolve({
      ok:   r.ok,
      json: () => Promise.resolve(r.body),
    });
  });
}

function makeSession(result: unknown = MOCK_RESULT, cancel = vi.fn()) {
  return {
    run:    vi.fn().mockResolvedValue(result),
    cancel,
  };
}

// ── Group A: fetchPronunciationStatus (scenarios 1-15) ────────────────────────

describe('fetchPronunciationStatus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', undefined);
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer test-token' });
  });

  it('1. fetches from correct URL with textVersionId query param', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'available', canAnalyze: true, assessmentId: null }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchPronunciationStatus(REVIEW_ID);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/pronunciation/status');
    expect(url).toContain(`textVersionId=${REVIEW_ID}`);
  });

  it('2. sends Authorization header from getAuthHeader', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'available', canAnalyze: true, assessmentId: null }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchPronunciationStatus(REVIEW_ID);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });

  it('3. returns data object from JSON response', async () => {
    const body = { status: 'available', canAnalyze: true, assessmentId: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }));

    const result = await fetchPronunciationStatus(REVIEW_ID);

    expect(result).toEqual(body);
  });

  it('4. returns available status when no assessment exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'available', canAnalyze: true, assessmentId: null }),
    }));

    const result = await fetchPronunciationStatus(REVIEW_ID);

    expect(result.status).toBe('available');
    expect(result.canAnalyze).toBe(true);
    expect(result.assessmentId).toBeNull();
  });

  it('5. returns processing status when assessment is being processed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'processing', canAnalyze: false, assessmentId: 'id-1' }),
    }));

    const result = await fetchPronunciationStatus(REVIEW_ID);

    expect(result.status).toBe('processing');
    expect(result.canAnalyze).toBe(false);
  });

  it('6. returns completed status with result field when completed', async () => {
    const body = {
      status: 'completed',
      canAnalyze: false,
      assessmentId: 'id-2',
      result: MOCK_RESULT,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }));

    const result = await fetchPronunciationStatus(REVIEW_ID);

    expect(result.status).toBe('completed');
    expect(result.result).toEqual(MOCK_RESULT);
  });

  it('7. returns failed_retryable status with canAnalyze=true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'failed_retryable', canAnalyze: true, assessmentId: 'id-3' }),
    }));

    const result = await fetchPronunciationStatus(REVIEW_ID);

    expect(result.status).toBe('failed_retryable');
    expect(result.canAnalyze).toBe(true);
  });

  it('8. returns failed_final status with canAnalyze=true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'failed_final', canAnalyze: true, assessmentId: 'id-4' }),
    }));

    const result = await fetchPronunciationStatus(REVIEW_ID);

    expect(result.status).toBe('failed_final');
    expect(result.canAnalyze).toBe(true);
  });

  it('9. throws PronunciationStatusError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    }));

    await expect(fetchPronunciationStatus(REVIEW_ID))
      .rejects.toThrow(PronunciationStatusError);
  });

  it('10. throws PronunciationStatusError on 404 with message from body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Revisão não encontrada.' }),
    }));

    await expect(fetchPronunciationStatus(REVIEW_ID))
      .rejects.toThrow('Revisão não encontrada.');
  });

  it('11. throws PronunciationStatusError on 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    }));

    await expect(fetchPronunciationStatus(REVIEW_ID))
      .rejects.toBeInstanceOf(PronunciationStatusError);
  });

  it('12. error includes HTTP status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    }));

    let caught: unknown;
    try {
      await fetchPronunciationStatus(REVIEW_ID);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PronunciationStatusError);
    expect((caught as PronunciationStatusError).statusCode).toBe(403);
  });

  it('13. passes signal to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'available', canAnalyze: true, assessmentId: null }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const controller = new AbortController();
    await fetchPronunciationStatus(REVIEW_ID, controller.signal);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBe(controller.signal);
  });

  it('14. propagates AbortError when signal is already aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('AbortError'), { name: 'AbortError' }),
    ));

    const controller = new AbortController();
    controller.abort();

    const err = await fetchPronunciationStatus(REVIEW_ID, controller.signal).catch(e => e);
    expect(err.name).toBe('AbortError');
  });

  it('15. URL-encodes the textVersionId query param', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'available', canAnalyze: true, assessmentId: null }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const id = 'abc+def=xyz/123';
    await fetchPronunciationStatus(id);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(encodeURIComponent(id));
    expect(url).not.toContain(id); // raw chars must be encoded
  });
});

// ── Group B: runAnalysisFlow (scenarios 16-37) ────────────────────────────────

describe('runAnalysisFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', undefined);
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer test-token' });
  });

  it('16. calls convertToWavPcm with audioBlob as first step', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'attempt-1', audioBlob: BLOB, audioDurationMs: 3000 },
      refs,
      vi.fn(),
    );

    expect(mockConvertToWavPcm).toHaveBeenCalledWith(BLOB);
  });

  it('17. sets phase preparing_audio at start', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const phases: string[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      (s) => phases.push(s.phase),
    );

    expect(phases[0]).toBe('preparing_audio');
  });

  it('18. sets phase failed with empty-recording message when audioBlob is null', async () => {
    const phases: AnalysisState[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: null, audioDurationMs: 0 },
      refs,
      (s) => phases.push(s),
    );

    const failed = phases.find(p => p.phase === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.errorMessage).toMatch(/vazia/i);
  });

  it('19. does NOT call /start when audioBlob is null', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: null, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const startCalls = mockFetch.mock.calls.filter(args => (args[0] as string).includes('/start'));
    expect(startCalls).toHaveLength(0);
  });

  it('20. does NOT call /fail when assessmentId is null (audio error pre-/start)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: null, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const failCalls = mockFetch.mock.calls.filter(args => (args[0] as string).includes('/fail'));
    expect(failCalls).toHaveLength(0);
  });

  it('21. sets phase reserving after audio conversion', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const phases: string[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      (s) => phases.push(s.phase),
    );

    expect(phases).toContain('reserving');
    expect(phases.indexOf('reserving')).toBeGreaterThan(phases.indexOf('preparing_audio'));
  });

  it('22. calls /start with idempotencyKey and textVersionId', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    const mockFetch = makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', mockFetch);

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'idem-123', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const startCall = mockFetch.mock.calls.find(args => (args[0] as string).includes('/start'));
    expect(startCall).toBeDefined();
    const body = JSON.parse(startCall![1].body);
    expect(body.textVersionId).toBe(REVIEW_ID);
    expect(body.idempotencyKey).toBe('idem-123');
  });

  it('23. sets phase analyzing after /start succeeds', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const phases: string[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      (s) => phases.push(s.phase),
    );

    expect(phases).toContain('analyzing');
  });

  it('24. creates recognition session with referenceText from /start response (not caller input)', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse({ referenceText: 'server reference text' }) },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const [sessionOpts] = mockCreateSession.mock.calls[0];
    expect(sessionOpts.referenceText).toBe('server reference text');
  });

  it('25. creates recognition session with token from /start response', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse({ token: 'super-secret-azure-token' }) },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const [sessionOpts] = mockCreateSession.mock.calls[0];
    expect(sessionOpts.token).toBe('super-secret-azure-token');
  });

  it('26. token from /start is not stored in refs', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse({ token: 'super-secret-azure-token' }) },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    // Token must not leak into refs (only assessmentId is stored)
    const refValues = Object.values(refs).map(r => r.current);
    expect(refValues.some(v => v === 'super-secret-azure-token')).toBe(false);
  });

  it('27. sets phase saving_result after Azure returns result', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const phases: string[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      (s) => phases.push(s.phase),
    );

    expect(phases).toContain('saving_result');
  });

  it('28. calls /complete with result and assessmentId', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession(MOCK_RESULT));
    const mockFetch = makeFetch([
      { ok: true, body: makeStartResponse({ assessmentId: 'assess-99' }) },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', mockFetch);

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const completeCalls = mockFetch.mock.calls.filter(args => (args[0] as string).includes('/complete'));
    expect(completeCalls).toHaveLength(1);
    const body = JSON.parse(completeCalls[0][1].body);
    expect(body.assessmentId).toBe('assess-99');
    expect(body.result).toEqual(MOCK_RESULT);
  });

  it('29. sets phase completed with result on success', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession(MOCK_RESULT));
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const states: AnalysisState[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      (s) => states.push(s),
    );

    const completed = states.find(s => s.phase === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.result).toEqual(MOCK_RESULT);
  });

  it('30. calls /fail with AZURE_NO_MATCH when Azure returns no match', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue({
      run:    vi.fn().mockRejectedValue(new MockPronunciationServiceError('AZURE_NO_MATCH', 'No match')),
      cancel: vi.fn(),
    });
    const mockFetch = makeFetch([
      { ok: true, body: makeStartResponse({ assessmentId: 'assess-50' }) },
      { ok: true, body: {} }, // /fail
    ]);
    vi.stubGlobal('fetch', mockFetch);

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const failCalls = mockFetch.mock.calls.filter(args => (args[0] as string).includes('/fail'));
    expect(failCalls).toHaveLength(1);
    const body = JSON.parse(failCalls[0][1].body);
    expect(body.code).toBe('AZURE_NO_MATCH');
  });

  it('31. sets phase failed with no-match message on AZURE_NO_MATCH', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue({
      run:    vi.fn().mockRejectedValue(new MockPronunciationServiceError('AZURE_NO_MATCH', 'No match')),
      cancel: vi.fn(),
    });
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const states: AnalysisState[] = [];
    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      (s) => states.push(s),
    );

    const failed = states.find(s => s.phase === 'failed');
    expect(failed?.errorMessage).toMatch(/fala.*detectada|nenhuma/i);
  });

  it('32. calls /fail with AZURE_CANCELED on generic Azure error', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue({
      run:    vi.fn().mockRejectedValue(new Error('Unknown Azure error')),
      cancel: vi.fn(),
    });
    const mockFetch = makeFetch([
      { ok: true, body: makeStartResponse({ assessmentId: 'assess-77' }) },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', mockFetch);

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    const failCalls = mockFetch.mock.calls.filter(args => (args[0] as string).includes('/fail'));
    expect(failCalls).toHaveLength(1);
    const body = JSON.parse(failCalls[0][1].body);
    expect(body.code).toBe('AZURE_CANCELED');
  });

  it('33. does not call onPhaseChange when mountedRef.current is false', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const onPhaseChange = vi.fn();
    const refs = makeFlowRefs();
    refs.mountedRef.current = false; // unmounted before flow starts

    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      onPhaseChange,
    );

    expect(onPhaseChange).not.toHaveBeenCalled();
  });

  it('34. sets flowLockRef.current = false on success', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    expect(refs.flowLockRef.current).toBe(true);

    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    expect(refs.flowLockRef.current).toBe(false);
  });

  it('35. sets flowLockRef.current = false on audio error (null blob)', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const refs = makeFlowRefs();
    expect(refs.flowLockRef.current).toBe(true);

    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: null, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    expect(refs.flowLockRef.current).toBe(false);
  });

  it('36. sets flowLockRef.current = false on Azure error', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue({
      run:    vi.fn().mockRejectedValue(new MockPronunciationServiceError('AZURE_CANCELED', 'cancelled')),
      cancel: vi.fn(),
    });
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse({ assessmentId: 'assess-xx' }) },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'a1', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    expect(refs.flowLockRef.current).toBe(false);
  });

  it('37. clears assessmentIdRef and idempotencyKeyRef on success', async () => {
    mockConvertToWavPcm.mockResolvedValue(WAV_FILE);
    mockCreateSession.mockReturnValue(makeSession());
    vi.stubGlobal('fetch', makeFetch([
      { ok: true, body: makeStartResponse() },
      { ok: true, body: {} },
    ]));

    const refs = makeFlowRefs();
    await runAnalysisFlow(
      { reviewId: REVIEW_ID, idempotencyKey: 'idem-final', audioBlob: BLOB, audioDurationMs: 0 },
      refs,
      vi.fn(),
    );

    expect(refs.assessmentIdRef.current).toBeNull();
    expect(refs.idempotencyKeyRef.current).toBeNull();
  });
});
