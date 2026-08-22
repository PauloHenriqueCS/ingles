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
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

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
  mockGetCurrentUserPlanEntitlements,
  mockResolveActivityPrompt,
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
  const mockGetCurrentUserPlanEntitlements = vi.fn();
  const mockResolveActivityPrompt = vi.fn();

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
    // Real production shape (getProductionDeps() always sets this) — a
    // stateful in-memory stand-in is installed per test in beforeEach so
    // dedupe behavior (begin/complete/fail) is exercised the same way
    // executeAiGatewayCall's enforce-mode pipeline uses the real
    // SupabaseDedupeStore, without hitting a real DB.
    dedupeStore: undefined as any,
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
    mockGetCurrentUserPlanEntitlements,
    mockResolveActivityPrompt,
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
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

// Data-driven prompt seam: the handler now resolves both the comparison and the
// final-correction prompts from the DB via resolveActivityPrompt. Keep the real
// CurriculumConfigError class (the handler branches on `instanceof`); only the
// resolver is mocked so no real DB / service-role credentials are needed.
vi.mock('../_curriculum/service-client', () => ({ getCurriculumServiceClient: () => ({}) }));
vi.mock('../_curriculum/curriculum-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_curriculum/curriculum-runtime')>();
  return { ...actual, resolveActivityPrompt: mockResolveActivityPrompt };
});

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

// ── Stateful in-memory dedupe store ────────────────────────────────────────────
// Reimplements the exact outcome semantics of begin_gateway_idempotent_op_v1 /
// complete_gateway_idempotent_op_v1 / fail_gateway_idempotent_op_v1 (see
// supabase/migrations/20260718020000_..._function_ambiguity_fix.sql) without a
// real DB: fresh key -> 'started'; live lock, same key -> 'in_progress' or
// 'completed' (whatever it currently is); 'failed' or lease-expired -> reclaimed
// and reset to a live lock. Fresh instance per test (see beforeEach) so no
// state leaks between tests.
interface FakeDedupeLock {
  id: string;
  status: 'in_progress' | 'completed' | 'failed';
  resultRef: string | null;
  expiresAt: number;
}

function makeStatefulDedupeStore() {
  const locks = new Map<string, FakeDedupeLock>();
  let counter = 0;
  const store = {
    async begin(scope: string, idempotencyKey: string, leaseSeconds: number) {
      const key = `${scope}::${idempotencyKey}`;
      const now = Date.now();
      const existing = locks.get(key);
      if (!existing) {
        const id = `lock-${++counter}`;
        locks.set(key, { id, status: 'in_progress', resultRef: null, expiresAt: now + leaseSeconds * 1000 });
        return { lockId: id, outcome: 'started' as const, resultRef: null };
      }
      if (existing.status === 'failed' || existing.expiresAt <= now) {
        existing.status = 'in_progress';
        existing.resultRef = null;
        existing.expiresAt = now + leaseSeconds * 1000;
        return { lockId: existing.id, outcome: 'reclaimed' as const, resultRef: null };
      }
      return { lockId: existing.id, outcome: existing.status, resultRef: existing.resultRef };
    },
    async complete(lockId: string, resultRef: string | null) {
      for (const lock of locks.values()) {
        if (lock.id === lockId) { lock.status = 'completed'; lock.resultRef = resultRef; }
      }
    },
    async fail(lockId: string) {
      for (const lock of locks.values()) {
        if (lock.id === lockId) { lock.status = 'failed'; }
      }
    },
  };
  // Test-only escape hatch (not part of DedupeStoreInterface): simulates the
  // real expires_at TTL elapsing, without faking global timers. Mirrors what
  // begin_gateway_idempotent_op_v1 checks (`agil.expires_at <= v_now`) —
  // does NOT change status, exactly like real TTL expiry never touches it.
  const expireAllLocks = () => {
    for (const lock of locks.values()) lock.expiresAt = Date.now() - 1;
  };
  return { store, expireAllLocks };
}

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}

function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), training: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

// Set fresh in beforeEach; reassigned there so tests can call
// expireDedupeLocks() to simulate the real TTL elapsing (see
// makeStatefulDedupeStore's expireAllLocks above).
let expireDedupeLocks: () => void = () => {};

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
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  mockResolveActivityPrompt.mockResolvedValue({
    system: 'SYSTEM PROMPT',
    user: 'USER PROMPT',
    model: null,
    temperature: null,
    subtopicKey: null,
    versionId: 'ver-1',
    languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
  });
  const dedupe = makeStatefulDedupeStore();
  mockDeps.dedupeStore = dedupe.store;
  expireDedupeLocks = dedupe.expireAllLocks;
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

describe('plan entitlements gate', () => {
  it('blocks with FEATURE_DISABLED when writing.enabled is false, before calling OpenAI', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartEvent).not.toHaveBeenCalled();
  });

  it('blocks generateFinalTextOnly mode too when writing.enabled is false', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeFinalOnlyReq(), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect(mockCreate).not.toHaveBeenCalled();
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

// ── 3b. Output-language guard on the "Versão final corrigida" ─────────────────
// The reported bug: the final corrected version came back mixing Portuguese into
// the student's English. The guard verifies the output language and retries once;
// it must never silently persist/return a wrong- or mixed-language correction.

describe('generateFinalTextOnly — output-language guard', () => {
  const PT_OUTPUT = 'Olá! Eu não sei o seu nome, mas eu gostaria de saber mais sobre você e a sua família hoje.';
  const EN_OUTPUT = 'Hello! I do not know your name yet, but I would like to know more about you and your family today.';

  it('a clean English correction passes with a SINGLE AI call (no false retry)', async () => {
    mockCreate.mockImplementation(() => aiOk(EN_OUTPUT));
    const res = makeRes();
    await handler(makeFinalOnlyReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBe(EN_OUTPUT);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('retries ONCE when the first output is in the wrong language, then succeeds', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk(PT_OUTPUT))   // drift → rejected by guard
      .mockImplementationOnce(() => aiOk(EN_OUTPUT));  // retry → correct
    const res = makeRes();
    await handler(makeFinalOnlyReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBe(EN_OUTPUT);
  });

  it('never silently accepts a wrong-language correction: both attempts wrong → 502 AI_WRONG_LANGUAGE', async () => {
    mockCreate.mockImplementation(() => aiOk(PT_OUTPUT)); // stays wrong on retry too
    const res = makeRes();
    await handler(makeFinalOnlyReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res._status()).toBe(502);
    expect((res._body() as any).code).toBe('AI_WRONG_LANGUAGE');
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
    // Distinct reviewId per call so the two requests don't share an
    // idempotency key — this test is about legacy vs. observe response shape
    // parity, not dedupe, so the two calls must be treated as unrelated.
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const legacyRes = makeRes();
    await handler(makeReq({ body: { ...makeReq().body, reviewId: 'format-parity-legacy' } }), legacyRes);

    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const observeRes = makeRes();
    await handler(makeReq({ body: { ...makeReq().body, reviewId: 'format-parity-observe' } }), observeRes);

    expect(Object.keys(legacyRes._body() as object).sort()).toEqual(
      Object.keys(observeRes._body() as object).sort(),
    );
    expect(legacyRes._status()).toBe(observeRes._status());
  });
});

// ── 11. Dedupe — identical back-to-back requests are blocked, distinct ones aren't ──
// Supersedes the old "no new deduplication" test now that compare-rewrite.ts
// wires in SupabaseDedupeStore (the full idempotency test suite is further
// down this file — see "idempotency — SupabaseDedupeStore wired into
// compare-rewrite").

describe('identical back-to-back requests are deduped', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('a genuinely concurrent duplicate is blocked, not re-run against the AI', async () => {
    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([handler(makeReq(), res1), handler(makeReq({ body: { ...makeReq().body } }), res2)]);

    expect(mockCreate).toHaveBeenCalledTimes(2); // one full round total, not two
    expect([res1._status(), res2._status()].sort()).toEqual([200, 409]);
    const blocked = res1._status() === 409 ? res1 : res2;
    expect((blocked._body() as any).code).toBe('DUPLICATE_REQUEST_IN_PROGRESS');
  });

  it('a sequential retry after the first request already finished gets its own fresh result (no persisted replay in this mode — see the dedicated "completed" suite below)', async () => {
    const res1 = makeRes();
    await handler(makeReq(), res1);
    expect(res1._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    const res2 = makeRes();
    await handler(makeReq(), res2);
    expect(res2._status()).toBe(200); // not 409 — 'completed' is never reported as "in progress"
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('two requests with genuinely different content each get their own AI calls', async () => {
    const res1 = makeRes();
    await handler(makeReq(), res1);

    const res2 = makeRes();
    await handler(
      makeReq({ body: { ...makeReq().body, rewriteText: 'A genuinely different rewrite attempt written here.' } }),
      res2,
    );

    expect(res1._status()).toBe(200);
    expect(res2._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(4);

    const correlationIds = mockStartEvent.mock.calls.map((c) => (c[0] as any).correlationId);
    const uniqueCorrelationIds = new Set(correlationIds);
    // 2 requests x 1 correlationId each, shared within a request only.
    expect(uniqueCorrelationIds.size).toBe(2);
  });
});

// ── 12. Content-quality gate — rejects gibberish before touching OpenAI/rate limit ──

describe('content-quality validation (invalid rewrite text)', () => {
  it('generateFinalTextOnly: the exact reported bug input is rejected with 400 INVALID_REWRITE_TEXT, no OpenAI call', async () => {
    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, correctedText: 'Yesterday I went to the store.', rewriteText: '5eysvduduud' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_REWRITE_TEXT');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
  });

  it('generateFinalTextOnly: multi-token gibberish is rejected with 400 INVALID_REWRITE_TEXT', async () => {
    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, correctedText: 'Yesterday I went to the store.', rewriteText: 'xkcd qzwe mnbv zxqw' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_REWRITE_TEXT');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('generateFinalTextOnly: a short but legitimate sentence is NOT rejected by the content gate', async () => {
    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, correctedText: 'Yesterday I went to the store.', rewriteText: 'I like cats.' } }), res);
    expect(res._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalled();
  });

  it('LEGACY default mode: gibberish rewriteText is rejected with 400 INVALID_REWRITE_TEXT, no OpenAI call', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { originalText: 'Yesterday I goed to the store.', correctedText: 'Yesterday I went to the store.', rewriteText: '5eysvduduud', mainMistakes: [] } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_REWRITE_TEXT');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
  });
});

// ── Item 7: idempotent final-text generation + persistence ────────────────────
//
// A chainable Supabase mock records writes so each scenario can assert exactly
// how many AI calls happened and what was persisted. Confirms: reuse of a stored
// result skips the AI; a fresh generation calls the AI once and persists it +
// promotes the day to 'revisado'; a meaningfully changed V2 regenerates.

function makeSupabaseMock(reviewRow: Record<string, unknown> | null) {
  const updatedReviews: Record<string, unknown>[] = [];
  const updatedEntries: Record<string, unknown>[] = [];
  function from(table: string) {
    const builder: any = {
      _table: table,
      select() { return builder; },
      update(vals: Record<string, unknown>) {
        if (table === 'english_reviews') updatedReviews.push(vals);
        if (table === 'writing_entries') updatedEntries.push(vals);
        return builder;
      },
      eq() { return builder; },
      neq() { return builder; },
      maybeSingle() { return Promise.resolve({ data: reviewRow, error: null }); },
      then(resolve: (v: { error: null }) => unknown) { return Promise.resolve({ error: null }).then(resolve); },
    };
    return builder;
  }
  return { from, _updatedReviews: updatedReviews, _updatedEntries: updatedEntries } as any;
}

const REVIEW_ID = 'bbbbbbbb-0000-0000-0000-000000000009';
const V2_TEXT = 'Yesterday I went to the store and buyed bread.';

describe('generateFinalTextOnly — idempotency & persistence (item 7)', () => {
  it('reuses the stored final text WITHOUT calling the AI when V2 is unchanged', async () => {
    const supabase = makeSupabaseMock({
      version_2_text: V2_TEXT,
      version_2_final_text: 'STORED FINAL VERSION',
      entry_date: '2026-07-30',
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });

    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, reviewId: REVIEW_ID, correctedText: 'Yesterday I went to the store.', rewriteText: V2_TEXT } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBe('STORED FINAL VERSION');
    expect((res._body() as any).reused).toBe(true);
    expect((res._body() as any).persisted).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();          // NO AI call
    expect(mockApplyRateLimit).not.toHaveBeenCalled();  // reuse short-circuits before rate limit
    expect(supabase._updatedEntries).toHaveLength(1);   // promoted to 'revisado'
    expect(supabase._updatedEntries[0]).toEqual({ status: 'revisado' });
  });

  it('normalizes trivial differences (curly apostrophe/case/spacing) as unchanged → still no AI call', async () => {
    const supabase = makeSupabaseMock({
      version_2_text: "I'm not certain about it.",
      version_2_final_text: 'STORED FINAL VERSION',
      entry_date: '2026-07-30',
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });

    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, reviewId: REVIEW_ID, correctedText: 'x', rewriteText: '  I’m   NOT certain about it  ' } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).reused).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('generates once and persists (+ promotes to revisado) when no final text exists yet', async () => {
    mockCreate.mockImplementation(() => aiOk('FRESHLY GENERATED FINAL TEXT'));
    const supabase = makeSupabaseMock({
      version_2_text: V2_TEXT,
      version_2_final_text: null,
      entry_date: '2026-07-30',
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });

    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, reviewId: REVIEW_ID, correctedText: 'Yesterday I went to the store.', rewriteText: V2_TEXT } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBe('FRESHLY GENERATED FINAL TEXT');
    expect((res._body() as any).persisted).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);        // exactly ONE AI call
    expect(supabase._updatedReviews).toHaveLength(1);
    expect(supabase._updatedReviews[0]).toEqual({ version_2_final_text: 'FRESHLY GENERATED FINAL TEXT' });
    expect(supabase._updatedEntries[0]).toEqual({ status: 'revisado' });
  });

  it('regenerates (AI call) when the stored V2 changed meaningfully, not reusing the old final', async () => {
    mockCreate.mockImplementation(() => aiOk('REGENERATED FINAL TEXT'));
    const supabase = makeSupabaseMock({
      version_2_text: 'A completely different earlier version.',
      version_2_final_text: 'OLD STORED FINAL',
      entry_date: '2026-07-30',
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });

    const res = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, reviewId: REVIEW_ID, correctedText: 'x', rewriteText: V2_TEXT } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBe('REGENERATED FINAL TEXT');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(supabase._updatedReviews[0]).toEqual({ version_2_final_text: 'REGENERATED FINAL TEXT' });
  });

  it('without a reviewId falls back to AI-only, reports persisted:false (client persists)', async () => {
    mockCreate.mockImplementation(() => aiOk('FINAL TEXT NO REVIEW'));
    const res = makeRes();
    await handler(makeFinalOnlyReq(), res); // no reviewId

    expect(res._status()).toBe(200);
    expect((res._body() as any).finalCorrectedText).toBe('FINAL TEXT NO REVIEW');
    expect((res._body() as any).persisted).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ── Idempotency — SupabaseDedupeStore wired into compare-rewrite ──────────────
//
// Covers both flows this endpoint fixes: generateFinalTextOnly and the
// default compare+correct mode. mockDeps.dedupeStore (see
// makeStatefulDedupeStore above) reimplements the real begin/complete/fail
// outcome semantics in memory, fresh per test via the file-level beforeEach.
//
// "Concurrent" here means two handler() calls launched via Promise.all
// without awaiting the first — since both run the identical code path with
// the identical number of await points up to dedupeStore.begin(), and
// Promise.all evaluates them left-to-right, the microtask queue always lets
// the first call reach (and synchronously win) its begin() call before the
// second call reaches its own — deterministic, no artificial delay needed.
// Assertions below are written to hold regardless of which one wins.

const DEDUPE_REVIEW_ID = 'cccccccc-0000-0000-0000-000000000099';

describe('idempotency — SupabaseDedupeStore wired into compare-rewrite', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  // 1. Two concurrent generateFinalTextOnly calls → exactly one AI call.
  it('generateFinalTextOnly: two concurrent identical requests result in exactly one AI call', async () => {
    const supabase = makeSupabaseMock({ version_2_text: V2_TEXT, version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockCreate.mockImplementation(() => aiOk('FINAL TEXT'));
    const body = { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, correctedText: 'Yesterday I went to the store.', rewriteText: V2_TEXT };

    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      handler(makeFinalOnlyReq({ body }), res1),
      handler(makeFinalOnlyReq({ body: { ...body } }), res2),
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect([res1._status(), res2._status()].sort()).toEqual([200, 409]);
    const blocked = res1._status() === 409 ? res1 : res2;
    expect((blocked._body() as any).code).toBe('DUPLICATE_REQUEST_IN_PROGRESS');
  });

  // 2. Sequential retry with the same V2 → no duplicate AI call.
  it('generateFinalTextOnly: retrying with the same V2 right after does not call the AI again', async () => {
    const supabase = makeSupabaseMock({ version_2_text: V2_TEXT, version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockCreate.mockImplementation(() => aiOk('FINAL TEXT'));
    const body = { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, correctedText: 'Yesterday I went to the store.', rewriteText: V2_TEXT };

    const res1 = makeRes();
    await handler(makeFinalOnlyReq({ body }), res1);
    expect(res1._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const res2 = makeRes();
    await handler(makeFinalOnlyReq({ body: { ...body } }), res2);
    expect(res2._status()).toBe(409);
    expect(mockCreate).toHaveBeenCalledTimes(1); // still 1 — no duplicate call
  });

  // 3. A meaningfully different V2 gets its own AI call.
  it('generateFinalTextOnly: a meaningfully different V2 is allowed a fresh AI call', async () => {
    const supabase = makeSupabaseMock({ version_2_text: V2_TEXT, version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockCreate.mockImplementation(() => aiOk('FINAL TEXT'));
    const baseBody = { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, correctedText: 'Yesterday I went to the store.' };

    const res1 = makeRes();
    await handler(makeFinalOnlyReq({ body: { ...baseBody, rewriteText: V2_TEXT } }), res1);
    expect(res1._status()).toBe(200);

    const res2 = makeRes();
    await handler(makeFinalOnlyReq({ body: { ...baseBody, rewriteText: 'A completely different sentence about a trip to Paris.' } }), res2);
    expect(res2._status()).toBe(200);

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // 4. Trivial edits (case/spacing/quotes/final punctuation) → same key, no duplicate call.
  it('generateFinalTextOnly: case/spacing/quote/punctuation-only edits reuse the same key', async () => {
    const trivialV2 = "I'm not certain about the answer.";
    const supabase = makeSupabaseMock({ version_2_text: trivialV2, version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockCreate.mockImplementation(() => aiOk('FINAL TEXT'));
    const baseBody = { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, correctedText: 'Yesterday I went to the store.' };

    const res1 = makeRes();
    await handler(makeFinalOnlyReq({ body: { ...baseBody, rewriteText: trivialV2 } }), res1);
    expect(res1._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Curly apostrophe instead of straight, uppercased, extra whitespace, no
    // trailing period — all normalized away by normalizeForComparison.
    const res2 = makeRes();
    await handler(makeFinalOnlyReq({ body: { ...baseBody, rewriteText: '  I’m   NOT certain about the answer  ' } }), res2);
    expect(res2._status()).toBe(409);
    expect(mockCreate).toHaveBeenCalledTimes(1); // no new call — same normalized key
  });

  // 5. Two concurrent default-mode calls → exactly one AI round (comparison + correction).
  it('default mode: two concurrent identical requests result in exactly one AI round (2 calls)', async () => {
    const body = {
      originalText: 'Yesterday I goed to the store.',
      correctedText: 'Yesterday I went to the store.',
      rewriteText: 'Yesterday I went to the store and buyed bread.',
      mainMistakes: [],
      reviewId: DEDUPE_REVIEW_ID,
    };

    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      handler(makeReq({ body }), res1),
      handler(makeReq({ body: { ...body } }), res2),
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2); // comparison + correction, once total
    expect([res1._status(), res2._status()].sort()).toEqual([200, 409]);
  });

  // 6. The two flows' keys never collide, even with identical reviewId/text.
  it('generateFinalTextOnly and default-mode keys never collide, even with identical reviewId and text', async () => {
    const supabase = makeSupabaseMock({ version_2_text: 'Yesterday I went to the store and buyed bread.', version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockCreate.mockImplementation(() => aiOk(VALID_COMPARE_RESPONSE));

    const sharedText = {
      originalText: 'Yesterday I goed to the store.',
      correctedText: 'Yesterday I went to the store.',
      rewriteText: 'Yesterday I went to the store and buyed bread.',
    };

    const finalOnlyRes = makeRes();
    await handler(makeFinalOnlyReq({ body: { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, ...sharedText } }), finalOnlyRes);
    expect(finalOnlyRes._status()).toBe(200);

    const defaultRes = makeRes();
    await handler(makeReq({ body: { ...sharedText, mainMistakes: [], reviewId: DEDUPE_REVIEW_ID } }), defaultRes);
    expect(defaultRes._status()).toBe(200);

    expect(mockCreate).toHaveBeenCalledTimes(3); // 1 (final-only) + 2 (compare + correction) — neither blocked the other
  });

  // 7. A prior failure releases the lock for the very next retry.
  it('generateFinalTextOnly: a failed attempt releases the lock so the next retry can call the AI again', async () => {
    const supabase = makeSupabaseMock({ version_2_text: V2_TEXT, version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    const body = { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, correctedText: 'Yesterday I went to the store.', rewriteText: V2_TEXT };

    mockCreate.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('server error'), { status: 500 })));
    const res1 = makeRes();
    await handler(makeFinalOnlyReq({ body }), res1);
    expect(res1._status()).toBe(503);

    mockCreate.mockImplementationOnce(() => aiOk('RECOVERED FINAL TEXT'));
    const res2 = makeRes();
    await handler(makeFinalOnlyReq({ body: { ...body } }), res2);
    expect(res2._status()).toBe(200);
    expect((res2._body() as any).finalCorrectedText).toBe('RECOVERED FINAL TEXT');

    expect(mockCreate).toHaveBeenCalledTimes(2); // one failed attempt + one successful retry
  });

  // 8. No raw Gateway/internal error ever reaches the client.
  it('never leaks the raw Gateway DUPLICATE_IN_PROGRESS code or dedupe-store internals to the client', async () => {
    const supabase = makeSupabaseMock({ version_2_text: V2_TEXT, version_2_final_text: null, entry_date: '2026-07-30' });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockCreate.mockImplementation(() => aiOk('FINAL TEXT'));
    const body = { generateFinalTextOnly: true, reviewId: DEDUPE_REVIEW_ID, correctedText: 'Yesterday I went to the store.', rewriteText: V2_TEXT };

    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      handler(makeFinalOnlyReq({ body }), res1),
      handler(makeFinalOnlyReq({ body: { ...body } }), res2),
    ]);
    const blocked = res1._status() === 409 ? res1 : res2;
    const blockedBody = JSON.stringify(blocked._body());
    expect((blocked._body() as any).code).toBe('DUPLICATE_REQUEST_IN_PROGRESS');
    expect(blockedBody).not.toContain('DUPLICATE_IN_PROGRESS');
    expect(blockedBody).not.toContain('GatewayError');

    // Dedupe-store outage must fail closed with a generic message, never the raw driver error.
    mockDeps.dedupeStore.begin = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:5432 raw pg driver detail'));
    const res3 = makeRes();
    await handler(
      makeFinalOnlyReq({ body: { generateFinalTextOnly: true, reviewId: 'other-review-id', correctedText: 'x', rewriteText: 'Some other unrelated version two text here.' } }),
      res3,
    );
    expect(res3._status()).toBe(503);
    const res3Body = JSON.stringify(res3._body());
    expect(res3Body).not.toContain('ECONNREFUSED');
    expect(res3Body).not.toContain('pg driver');
  });
});

// ── Idempotency — default mode 'completed' outcome without a persisted replay ──
//
// Gap this covers: generateFinalTextOnly can replay a 'completed' lock via
// english_reviews.version_2_final_text (see lookupStoredFinalText in
// compare-rewrite.ts); the default (compare_and_correct) mode persists
// nothing — result/finalCorrectedText only ever live in the HTTP response.
// A lock that finished right before its HTTP response was lost in transit
// must not be reported as "still in progress" (that's false — complete()
// only ever runs after invoke() returns) and must not leave a retry stuck
// until the lock's own TTL elapses (begin_gateway_idempotent_op_v1 never
// resets expires_at on complete()/fail() — see compare-rewrite.ts's
// "Concurrency dedup" comment in the default-mode block for the exact RPC
// semantics this relies on).

const NO_REPLAY_REVIEW_ID = 'dddddddd-0000-0000-0000-000000000077';

function noReplayBody(overrides: Record<string, unknown> = {}) {
  return {
    originalText: 'Yesterday I goed to the store.',
    correctedText: 'Yesterday I went to the store.',
    rewriteText: 'Yesterday I went to the store and buyed bread.',
    mainMistakes: [],
    reviewId: NO_REPLAY_REVIEW_ID,
    ...overrides,
  };
}

describe("idempotency — default mode 'completed' outcome (no persisted replay)", () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  // 1. Two concurrent identical requests → exactly two AI calls total (one full round).
  it('two concurrent identical requests result in exactly two AI calls total', async () => {
    const res1 = makeRes();
    const res2 = makeRes();
    await Promise.all([
      handler(makeReq({ body: noReplayBody() }), res1),
      handler(makeReq({ body: noReplayBody() }), res2),
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect([res1._status(), res2._status()].sort()).toEqual([200, 409]);
  });

  // 2 + 3. First operation completes (its HTTP response is the one treated as
  // "lost" — the test just never inspects it); a retry with the exact same
  // key gets its own fresh, successful result instead of being stuck behind
  // the already-finished lock.
  it('a retry after the response was lost gets a fresh 200 result, not blocked', async () => {
    const res1 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res1);
    expect(res1._status()).toBe(200); // the response the client "never received"
    expect(mockCreate).toHaveBeenCalledTimes(2);

    const res2 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res2);

    // 3. What the retry gets back: a real 200 with the same result shape as
    // any other successful default-mode response — not a 409, not an error.
    expect(res2._status()).toBe(200);
    expect((res2._body() as any).result).toBeTruthy();
    expect((res2._body() as any).result.improvementScore).toBeDefined();

    // No safe replay exists for this mode, so this is a fresh generation —
    // an accepted, bounded tradeoff, never a silent stall.
    expect(mockCreate).toHaveBeenCalledTimes(4); // 2 (first attempt) + 2 (retry)
  });

  // 4. 'completed' never produces the "still in progress" wording/code.
  it('completed never returns the in-progress/wait response', async () => {
    await handler(makeReq({ body: noReplayBody() }), makeRes());

    const res2 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res2);

    expect(res2._status()).not.toBe(409);
    const body2 = JSON.stringify(res2._body());
    expect(body2).not.toContain('DUPLICATE_REQUEST_IN_PROGRESS');
    expect(body2).not.toContain('processada');
    expect(body2).not.toContain('aguarde');
  });

  // 5. No permanent block: several consecutive retries after completion all succeed.
  it('no user is ever permanently blocked by a completed key — repeated retries all succeed', async () => {
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await handler(makeReq({ body: noReplayBody() }), res);
      expect(res._status()).toBe(200);
    }
    expect(mockCreate).toHaveBeenCalledTimes(6); // 3 attempts x 2 calls each, none blocked
  });

  // 6. TTL behavior: once the lock's lease elapses, the next begin() reclaims
  // it as a normal, fully-tracked lock again — not the no-lock fallback.
  it('after the lock TTL elapses, the next attempt reclaims it as a tracked lock', async () => {
    const completeSpy = vi.spyOn(mockDeps.dedupeStore, 'complete');

    const res1 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res1);
    expect(res1._status()).toBe(200);
    expect(completeSpy).toHaveBeenCalledTimes(1);

    expireDedupeLocks();

    const res2 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res2);
    expect(res2._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(4);
    // Reclaimed as a real lock (not the completed/no-lock fallback): its own
    // completion is tracked too, unlike the within-TTL retry in test 7 below.
    expect(completeSpy).toHaveBeenCalledTimes(2);
  });

  // 7. complete()/fail() are called correctly on every exit path.
  describe('complete()/fail() bookkeeping', () => {
    it('success calls complete() once and never fail()', async () => {
      const completeSpy = vi.spyOn(mockDeps.dedupeStore, 'complete');
      const failSpy = vi.spyOn(mockDeps.dedupeStore, 'fail');
      await handler(makeReq({ body: noReplayBody() }), makeRes());
      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(failSpy).not.toHaveBeenCalled();
    });

    it('invalid JSON from the comparison call fails() the lock, never completes it', async () => {
      const completeSpy = vi.spyOn(mockDeps.dedupeStore, 'complete');
      const failSpy = vi.spyOn(mockDeps.dedupeStore, 'fail');
      mockCreate.mockImplementationOnce(() => aiOk('not valid json'));
      await handler(makeReq({ body: noReplayBody() }), makeRes());
      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).not.toHaveBeenCalled();
    });

    it('a provider error on the comparison call fails() the lock, never completes it', async () => {
      const completeSpy = vi.spyOn(mockDeps.dedupeStore, 'complete');
      const failSpy = vi.spyOn(mockDeps.dedupeStore, 'fail');
      mockCreate.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('down'), { status: 500 })));
      await handler(makeReq({ body: noReplayBody() }), makeRes());
      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).not.toHaveBeenCalled();
    });

    it('a best-effort failure of the second (correction) call still completes the lock', async () => {
      const completeSpy = vi.spyOn(mockDeps.dedupeStore, 'complete');
      const failSpy = vi.spyOn(mockDeps.dedupeStore, 'fail');
      mockCreate
        .mockImplementationOnce(() => aiOk(VALID_COMPARE_RESPONSE))
        .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('down'), { status: 500 })));
      const res = makeRes();
      await handler(makeReq({ body: noReplayBody() }), res);
      expect(res._status()).toBe(200); // comparison result still returned
      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(failSpy).not.toHaveBeenCalled();
    });

    it('a retry that lands on a completed-with-no-replay lock never calls complete()/fail() on the stale lock', async () => {
      await handler(makeReq({ body: noReplayBody() }), makeRes());

      const completeSpy = vi.spyOn(mockDeps.dedupeStore, 'complete');
      const failSpy = vi.spyOn(mockDeps.dedupeStore, 'fail');
      const res2 = makeRes();
      await handler(makeReq({ body: noReplayBody() }), res2);
      expect(res2._status()).toBe(200);
      // This retry holds no lock of its own (the stale one isn't reclaimable
      // early), so it never touches complete()/fail() at all.
      expect(completeSpy).not.toHaveBeenCalled();
      expect(failSpy).not.toHaveBeenCalled();
    });
  });

  // 8. Failure between the two AI calls (the first call itself fails, so the
  // second never runs) releases the lock — the very next retry succeeds.
  it('a failure on the first AI call releases the lock so the retry can call the AI again', async () => {
    mockCreate.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('server error'), { status: 500 })));
    const res1 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res1);
    expect(res1._status()).toBe(503);
    expect(mockCreate).toHaveBeenCalledTimes(1); // only the failed comparison call — correction never ran

    const res2 = makeRes();
    await handler(makeReq({ body: noReplayBody() }), res2);
    expect(res2._status()).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(3); // 1 failed + 2 (comparison + correction) for the retry
  });
});
