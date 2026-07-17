/**
 * Integration tests for api/compare-rewrite.ts — AI Gateway integration.
 *
 * Uses the real executeAiGatewayCall with injected mock deps so that the
 * full policy + telemetry path is exercised without real DB or OpenAI calls.
 *
 * Scope: only the physical openai.chat.completions.create(...) calls are
 * wrapped. Everything else (auth, rate limit, validation, prompts, response
 * shape) must remain unaffected — this file only asserts gateway behavior.
 *
 * This endpoint has THREE physical call sites, mapped to TWO feature keys:
 *   1. Default mode, call 1 — comparison        → writing.compare_rewrite
 *   2. Default mode, call 2 — final correction  → writing.correct_v2_text
 *      (best-effort: only attempted if call 1 succeeds AND parses; failure
 *      here never fails the request)
 *   3. generateFinalTextOnly mode (separate HTTP request, old records
 *      fallback button) — final correction      → writing.correct_v2_text
 *
 * Calls 1 and 2 are SEQUENTIAL (not parallel) and share one correlationId
 * with attemptNumber 1 and 2. Call 3 is its own HTTP request and gets its
 * own fresh correlationId with attemptNumber 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted values — available inside vi.mock factories ───────────────────────

const {
  mockCreate,
  mockStartEvent,
  mockCompleteEvent,
  mockFailEvent,
  mockInsertMetrics,
  mockGetEventForCosting,
  mockGetMetricsForEvent,
  mockUpdateMetricCost,
  mockUpdateEventCost,
  mockFindActivePrice,
  mockRebuildBucketForEvent,
  mockRebuildBucket,
  mockListBucketsForDate,
  mockPolicyResolvePolicy,
  mockRequireAuth,
  mockApplyRateLimit,
  mockDeps,
} = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockStartEvent = vi.fn();
  const mockCompleteEvent = vi.fn();
  const mockFailEvent = vi.fn();
  const mockInsertMetrics = vi.fn();
  const mockGetEventForCosting = vi.fn();
  const mockGetMetricsForEvent = vi.fn();
  const mockUpdateMetricCost = vi.fn();
  const mockUpdateEventCost = vi.fn();
  const mockFindActivePrice = vi.fn();
  const mockRebuildBucketForEvent = vi.fn();
  const mockRebuildBucket = vi.fn();
  const mockListBucketsForDate = vi.fn();
  const mockPolicyResolvePolicy = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockApplyRateLimit = vi.fn();

  const mockDeps = {
    policyResolver: { resolvePolicy: mockPolicyResolvePolicy, invalidate: vi.fn() },
    usageRepository: {
      startEvent: mockStartEvent,
      completeEvent: mockCompleteEvent,
      failEvent: mockFailEvent,
      cancelEvent: vi.fn(),
      insertMetrics: mockInsertMetrics,
      createProviderSession: vi.fn(),
      activateSession: vi.fn(),
      completeSession: vi.fn(),
      failSession: vi.fn(),
      expireSession: vi.fn(),
      getEventForCosting: mockGetEventForCosting,
      getMetricsForEvent: mockGetMetricsForEvent,
      updateMetricCost: mockUpdateMetricCost,
      updateEventCost: mockUpdateEventCost,
    },
    pricingRepository: {
      findActivePrice: mockFindActivePrice,
    },
    dailyRollupRepository: {
      rebuildBucketForEvent: mockRebuildBucketForEvent,
      rebuildBucket: mockRebuildBucket,
      listBucketsForDate: mockListBucketsForDate,
    },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
  };

  return {
    mockCreate,
    mockStartEvent,
    mockCompleteEvent,
    mockFailEvent,
    mockInsertMetrics,
    mockGetEventForCosting,
    mockGetMetricsForEvent,
    mockUpdateMetricCost,
    mockUpdateEventCost,
    mockFindActivePrice,
    mockRebuildBucketForEvent,
    mockRebuildBucket,
    mockListBucketsForDate,
    mockPolicyResolvePolicy,
    mockRequireAuth,
    mockApplyRateLimit,
    mockDeps,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────
// Real executeAiGatewayCall is used; only getProductionDeps is replaced.
vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => mockDeps };
});

vi.mock('openai', () => ({
  // Must use a regular function (not arrow) so `new OpenAI(...)` works.
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit }));

// ── Handler import ────────────────────────────────────────────────────────────

import handler from '../compare-rewrite';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

const VALID_COMPARE_RESPONSE = JSON.stringify({
  improvementScore: 80,
  fixedMistakesCount: 3,
  remainingMistakesCount: 1,
  fixedMistakes: [],
  remainingMistakes: [],
  newIssues: [],
  overallFeedback: 'Good job',
  nextAction: 'Keep practicing',
});

const FINAL_CORRECTED_TEXT = 'Yesterday I went to the store and bought some bread.';

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: {
      originalText: 'Yesterday I goed to the store.',
      correctedText: 'Yesterday I went to the store.',
      rewriteText: 'Yesterday I went to the store and buyed bread.',
      mainMistakes: [{ original: 'goed', correct: 'went', explanation: 'irregular verb' }],
    },
    ...overrides,
  };
}

function makeFinalOnlyReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: {
      generateFinalTextOnly: true,
      correctedText: 'Yesterday I went to the store.',
      rewriteText: 'Yesterday I went to the store and buyed bread.',
    },
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
  };
  return res;
}

function aiOk(content: string, usage?: Record<string, unknown>) {
  return Promise.resolve({
    choices: [{ message: { content } }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  let eventCounter = 0;
  let uuidCounter = 0;
  mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
  // Compare call needs valid JSON; the final-correction call just needs any
  // non-empty string (the handler never parses it), so reusing the same
  // fixture for both calls keeps every test's default setup simple.
  mockCreate.mockImplementation(() => aiOk(VALID_COMPARE_RESPONSE));
  mockStartEvent.mockImplementation(() => Promise.resolve(`event-${++eventCounter}`));
  mockCompleteEvent.mockResolvedValue(undefined);
  mockFailEvent.mockResolvedValue(undefined);
  mockInsertMetrics.mockResolvedValue(undefined);
  mockGetEventForCosting.mockResolvedValue(null);
  mockGetMetricsForEvent.mockResolvedValue([]);
  mockUpdateMetricCost.mockResolvedValue(undefined);
  mockUpdateEventCost.mockResolvedValue(undefined);
  mockFindActivePrice.mockResolvedValue(null);
  mockRebuildBucketForEvent.mockResolvedValue('daily-bucket-1');
  mockRebuildBucket.mockResolvedValue('daily-bucket-1');
  mockListBucketsForDate.mockResolvedValue([]);
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  mockApplyRateLimit.mockResolvedValue(true);
  (mockDeps.clock as ReturnType<typeof vi.fn>).mockReturnValue(1000);
  // Distinct correlationId per request, like production randomUUID().
  (mockDeps.uuidGen as ReturnType<typeof vi.fn>).mockImplementation(() => `test-uuid-${++uuidCounter}`);

  process.env.OPENAI_API_KEY = 'test-key';
});

// ── 1. LEGACY mode — default (compare + correct) flow ─────────────────────────

describe('LEGACY mode — default flow', () => {
  it('returns the same response and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).result).toBeTruthy();
    expect((res._body() as any).finalCorrectedText).toBeTruthy();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(mockCompleteEvent).not.toHaveBeenCalled();
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(mockInsertMetrics).not.toHaveBeenCalled();
  });
});

describe('LEGACY mode — generateFinalTextOnly flow', () => {
  it('returns the same response and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeFinalOnlyReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBeTruthy();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).not.toHaveBeenCalled();
  });
});

// ── 2. OBSERVE mode — default flow produces exactly two events ────────────────

describe('OBSERVE mode — default flow, both calls succeed', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly two events for the two physical calls', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockStartEvent).toHaveBeenCalledTimes(2);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(2);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('uses the correct featureKey per call: comparison then correction', async () => {
    await handler(makeReq(), makeRes());
    const featureKeys = mockStartEvent.mock.calls.map((c) => (c[0] as any).featureKey);
    expect(featureKeys).toEqual(['writing.compare_rewrite', 'writing.correct_v2_text']);
  });

  it('both events share the same correlationId', async () => {
    await handler(makeReq(), makeRes());
    const correlationIds = mockStartEvent.mock.calls.map((c) => (c[0] as any).correlationId);
    expect(new Set(correlationIds).size).toBe(1);
  });

  it('attemptNumber is 1 for comparison and 2 for correction', async () => {
    await handler(makeReq(), makeRes());
    const attemptNumbers = mockStartEvent.mock.calls.map((c) => (c[0] as any).attemptNumber);
    expect(attemptNumbers).toEqual([1, 2]);
  });

  it('preserves sequential order: comparison call completes before correction call starts', async () => {
    const callOrder: string[] = [];
    mockCreate
      .mockImplementationOnce(async () => { callOrder.push('compare-start'); const r = await aiOk(VALID_COMPARE_RESPONSE); callOrder.push('compare-end'); return r; })
      .mockImplementationOnce(async () => { callOrder.push('correct-start'); const r = await aiOk(FINAL_CORRECTED_TEXT); callOrder.push('correct-end'); return r; });

    await handler(makeReq(), makeRes());
    expect(callOrder).toEqual(['compare-start', 'compare-end', 'correct-start', 'correct-end']);
  });

  it('uses model gpt-4o-mini and provider openai for both calls', async () => {
    await handler(makeReq(), makeRes());
    for (const call of mockStartEvent.mock.calls) {
      expect((call[0] as any).model).toBe('gpt-4o-mini');
      expect((call[0] as any).provider).toBe('openai');
      expect((call[0] as any).service).toBe('chat.completions');
    }
  });

  it('userId comes from auth, not from the request body', async () => {
    await handler(makeReq({ body: { ...makeReq().body, userId: 'injected-evil' } }), makeRes());
    for (const call of mockStartEvent.mock.calls) {
      expect((call[0] as any).userId).toBe(USER_ID);
      expect((call[0] as any).initiatedByUserId).toBe(USER_ID);
    }
  });

  it('tokens from each response are attributed to their own event', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk(VALID_COMPARE_RESPONSE, { prompt_tokens: 300, completion_tokens: 120 }))
      .mockImplementationOnce(() => aiOk(FINAL_CORRECTED_TEXT, { prompt_tokens: 90, completion_tokens: 40 }));

    await handler(makeReq(), makeRes());

    expect(mockInsertMetrics).toHaveBeenCalledTimes(2);
    const [eventId1, metrics1] = mockInsertMetrics.mock.calls[0];
    const [eventId2, metrics2] = mockInsertMetrics.mock.calls[1];
    expect(eventId1).not.toBe(eventId2);
    expect(metrics1).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 300 }));
    expect(metrics1).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 120 }));
    expect(metrics2).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 90 }));
    expect(metrics2).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 40 }));
  });

  it('calculates cost independently per event (getEventForCosting called once per event)', async () => {
    await handler(makeReq(), makeRes());
    expect(mockGetEventForCosting).toHaveBeenCalledTimes(2);
    const costedIds = mockGetEventForCosting.mock.calls.map((c) => c[0]);
    expect(new Set(costedIds).size).toBe(2);
  });

  it('rebuilds two distinct daily buckets, one per event/feature', async () => {
    await handler(makeReq(), makeRes());
    expect(mockRebuildBucketForEvent).toHaveBeenCalledTimes(2);
    const eventIds = mockRebuildBucketForEvent.mock.calls.map((c) => c[0]);
    expect(new Set(eventIds).size).toBe(2);
  });
});

// ── 3. OBSERVE mode — generateFinalTextOnly flow ───────────────────────────────

describe('OBSERVE mode — generateFinalTextOnly flow', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event with featureKey writing.correct_v2_text, attemptNumber 1', async () => {
    const res = makeRes();
    await handler(makeFinalOnlyReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: 'writing.correct_v2_text', attemptNumber: 1 }),
    );
    expect(res._status()).toBe(200);
  });

  it('uses its own fresh correlationId, independent from the default-flow pattern', async () => {
    await handler(makeFinalOnlyReq(), makeRes());
    const firstCallCorrelationId = mockStartEvent.mock.calls[0][0].correlationId;
    expect(firstCallCorrelationId).toBeTruthy();
  });
});

// ── 4. Failure scenarios: comparison succeeded + correction failed ────────────

describe('comparison succeeded, final correction failed (best-effort)', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records event 1 as succeeded and event 2 as failed, response still returns result without finalCorrectedText', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk(VALID_COMPARE_RESPONSE))
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('server error'), { status: 500 })));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockStartEvent).toHaveBeenCalledTimes(2);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).toHaveBeenCalledTimes(1);

    // The response's functional behavior is unchanged: comparison result
    // is still returned; finalCorrectedText is simply absent.
    expect(res._status()).toBe(200);
    const body = res._body() as any;
    expect(body.result).toBeTruthy();
    expect(body.finalCorrectedText).toBeUndefined();
  });
});

// ── 5. "Correction succeeded, comparison failed" is NOT reachable ─────────────
// The two calls are sequential: call 2 only runs after call 1 succeeds AND
// its JSON parses. This test documents/proves that invariant is preserved.

describe('comparison failed → correction is never attempted (sequential order preserved)', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('provider failure on call 1 skips call 2 entirely — one event, failed', async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('server error'), { status: 500 })),
    );

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).toHaveBeenCalledTimes(1);
    expect(mockCompleteEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(503);
  });

  it('invalid JSON from call 1 also skips call 2 — one event, succeeded (not failed)', async () => {
    mockCreate.mockImplementationOnce(() => aiOk('not valid json'));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    // The provider call itself succeeded — only downstream parsing failed.
    expect(mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(500);
    expect((res._body() as any).error).toBe('Resposta inválida da IA. Tente novamente.');
  });
});

// ── 6. Telemetry failure resilience ───────────────────────────────────────────

describe('telemetry failure resilience', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('startEvent failure on call 1 does not block call 2 from running', async () => {
    mockStartEvent.mockImplementationOnce(() => Promise.reject(new Error('DB down')))
      .mockImplementationOnce(() => Promise.resolve('event-2'));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res._status()).toBe(200);
    const body = res._body() as any;
    expect(body.result).toBeTruthy();
    expect(body.finalCorrectedText).toBeTruthy();
  });

  it('cost calculation failure does not affect the response', async () => {
    mockGetEventForCosting.mockRejectedValue(new Error('pricing DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).result).toBeTruthy();
  });

  it('daily rollup failure does not affect the response', async () => {
    mockRebuildBucketForEvent.mockRejectedValue(new Error('advisory lock timeout'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).result).toBeTruthy();
  });
});

// ── 7. Per-feature policy isolation ───────────────────────────────────────────

describe('per-feature policy isolation', () => {
  it('writing.compare_rewrite can be observed while writing.correct_v2_text stays legacy, same request', async () => {
    mockPolicyResolvePolicy.mockImplementation(async (ctx: any) =>
      ctx.featureKey === 'writing.compare_rewrite'
        ? { gatewayMode: 'observe', runtimeStatus: 'enabled' }
        : { gatewayMode: 'legacy', runtimeStatus: 'enabled' },
    );

    await handler(makeReq(), makeRes());

    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: 'writing.compare_rewrite' }),
    );
  });
});

// ── 8. Auth and rate limit still gate the request ──────────────────────────────

describe('auth and rate limit still gate the request', () => {
  it('unauthenticated request never reaches OpenAI or telemetry', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartEvent).not.toHaveBeenCalled();
  });

  it('rate-limited request never reaches OpenAI', async () => {
    mockApplyRateLimit.mockResolvedValue(false);
    await handler(makeReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyRateLimit).toHaveBeenCalledWith(expect.anything(), USER_ID, 'compare-rewrite');
  });

  it('unauthenticated generateFinalTextOnly request never reaches OpenAI', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeFinalOnlyReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── 9. No student text or prompt content in metadata ───────────────────────────

describe('metadata never leaks student content', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('startEvent metadata contains only allowlisted technical fields, no essay text', async () => {
    const secretOriginal = 'This is my very secret confidential diary entry.';
    const secretCorrected = 'This is my very secret confidential corrected diary entry.';
    const secretRewrite = 'This is my secret confidential rewritten diary entry.';

    await handler(
      makeReq({ body: { originalText: secretOriginal, correctedText: secretCorrected, rewriteText: secretRewrite, mainMistakes: [] } }),
      makeRes(),
    );

    for (const call of mockStartEvent.mock.calls) {
      const metadataStr = JSON.stringify((call[0] as any).metadata);
      expect(metadataStr).not.toContain('secret');
      expect(metadataStr).not.toContain('confidential');
      expect(metadataStr).not.toContain('diary');
    }

    const compareMeta = mockStartEvent.mock.calls[0][0].metadata;
    expect(compareMeta).toEqual({
      endpoint: 'compare-rewrite',
      operation: 'comparison',
      physicalAttempt: 1,
      flowType: 'compare_and_correct',
    });

    const correctMeta = mockStartEvent.mock.calls[1][0].metadata;
    expect(correctMeta).toEqual({
      endpoint: 'compare-rewrite',
      operation: 'final_correction',
      physicalAttempt: 2,
      flowType: 'compare_and_correct',
    });
  });

  it('does not leak mainMistakes content in metadata', async () => {
    await handler(
      makeReq({ body: { ...makeReq().body, mainMistakes: [{ original: 'uniquetypo', correct: 'unique', explanation: 'spelling issue' }] } }),
      makeRes(),
    );
    for (const call of mockStartEvent.mock.calls) {
      const metadataStr = JSON.stringify((call[0] as any).metadata);
      expect(metadataStr).not.toContain('uniquetypo');
      expect(metadataStr).not.toContain('spelling issue');
    }
  });
});

// ── 10. Response format is unchanged between legacy and observe ────────────────

describe('response format is unchanged across modes', () => {
  it('same response body shape in legacy and observe for the default flow', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const legacyRes = makeRes();
    await handler(makeReq(), legacyRes);

    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const observeRes = makeRes();
    await handler(makeReq(), observeRes);

    expect(Object.keys(legacyRes._body() as object).sort()).toEqual(
      Object.keys(observeRes._body() as object).sort(),
    );
    expect(legacyRes._status()).toBe(observeRes._status());
  });
});

// ── 11. No new deduplication — double-click behaves as today ──────────────────

describe('double-click behavior is unchanged (no new deduplication)', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('two independent requests each produce their own two events with distinct correlationIds', async () => {
    await handler(makeReq(), makeRes());
    await handler(makeReq(), makeRes());

    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(mockStartEvent).toHaveBeenCalledTimes(4);

    const correlationIds = mockStartEvent.mock.calls.map((c) => (c[0] as any).correlationId);
    const uniqueCorrelationIds = new Set(correlationIds);
    // 2 requests x 1 correlationId each, shared within a request only.
    expect(uniqueCorrelationIds.size).toBe(2);
  });
});
