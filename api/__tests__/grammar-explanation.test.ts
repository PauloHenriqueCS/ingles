/**
 * Integration tests for api/grammar-explanation.ts — AI Gateway integration.
 *
 * Uses the real executeAiGatewayCall with injected mock deps so that the
 * full policy + telemetry path is exercised without real DB or OpenAI calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

// ── Hoisted values — available inside vi.mock factories ───────────────────────

const {
  mockCreate,
  mockMaybeSingle,
  mockStartEvent,
  mockCompleteEvent,
  mockFailEvent,
  mockInsertMetrics,
  mockPolicyResolvePolicy,
  mockRequireAuth,
  mockApplyRateLimit,
  mockGetCurrentUserPlanEntitlements,
  mockDeps,
} = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockMaybeSingle = vi.fn();
  const mockStartEvent = vi.fn();
  const mockCompleteEvent = vi.fn();
  const mockFailEvent = vi.fn();
  const mockInsertMetrics = vi.fn();
  const mockPolicyResolvePolicy = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockApplyRateLimit = vi.fn();
  const mockGetCurrentUserPlanEntitlements = vi.fn();

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
      getEventForCosting: vi.fn().mockResolvedValue(null),
      getMetricsForEvent: vi.fn().mockResolvedValue([]),
      updateMetricCost: vi.fn(),
      updateEventCost: vi.fn(),
    },
    pricingRepository: {
      findActivePrice: vi.fn().mockResolvedValue(null),
    },
    dailyRollupRepository: {
      rebuildBucketForEvent: vi.fn().mockResolvedValue(null),
      rebuildBucket: vi.fn(),
      listBucketsForDate: vi.fn().mockResolvedValue([]),
    },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
  };

  return {
    mockCreate,
    mockMaybeSingle,
    mockStartEvent,
    mockCompleteEvent,
    mockFailEvent,
    mockInsertMetrics,
    mockPolicyResolvePolicy,
    mockRequireAuth,
    mockApplyRateLimit,
    mockGetCurrentUserPlanEntitlements,
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

// ── Handler import ────────────────────────────────────────────────────────────

import handler from '../grammar-explanation';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GRAMMAR_CONTENT = { name: 'Present Simple', summaryPt: 'Tempo verbal básico.' };

const VALID_COMPLETION = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1720000000,
  model: 'gpt-4o-mini',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: JSON.stringify(GRAMMAR_CONTENT) },
    finish_reason: 'stop',
    logprobs: null,
  }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};

function makeSupabaseMock() {
  return {
    from: () => ({
      select: () => ({ ilike: () => ({ maybeSingle: mockMaybeSingle }) }),
    }),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '50',
      authorization: 'Bearer test-token',
    },
    body: { grammarName: 'Present Simple', ...overrides },
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

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}

function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults — overridden per test as needed
  mockMaybeSingle.mockResolvedValue({ data: null, error: null }); // cache miss
  mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
  mockCreate.mockResolvedValue(VALID_COMPLETION);
  mockStartEvent.mockResolvedValue('event-id-1');
  mockCompleteEvent.mockResolvedValue(undefined);
  mockFailEvent.mockResolvedValue(undefined);
  mockInsertMetrics.mockResolvedValue(undefined);
  mockRequireAuth.mockResolvedValue({ userId: 'user-123', supabase: makeSupabaseMock() });
  mockApplyRateLimit.mockResolvedValue(true);
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  (mockDeps.clock as ReturnType<typeof vi.fn>).mockReturnValue(1000);
  (mockDeps.uuidGen as ReturnType<typeof vi.fn>).mockReturnValue('test-uuid');

  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

// ── LEGACY mode ───────────────────────────────────────────────────────────────

describe('LEGACY mode — cache miss', () => {
  it('calls OpenAI exactly once', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('returns correct content and cached:false', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ content: GRAMMAR_CONTENT, cached: false });
  });

  it('writes no telemetry rows', async () => {
    await handler(makeReq(), makeRes());
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(mockCompleteEvent).not.toHaveBeenCalled();
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('preserves provider error status and code', async () => {
    const rateLimitErr = Object.assign(new Error('rate limited'), { status: 429 });
    mockCreate.mockRejectedValue(rateLimitErr);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(503);
    expect((res._body() as any).code).toBe('AI_UNAVAILABLE');
    expect(mockStartEvent).not.toHaveBeenCalled();
  });
});

// ── OBSERVE mode — cache miss / success ───────────────────────────────────────

describe('OBSERVE mode — cache miss / success', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('calls OpenAI exactly once', async () => {
    await handler(makeReq(), makeRes());
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('returns correct content and cached:false', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ content: GRAMMAR_CONTENT, cached: false });
  });

  it('records started event with correct context', async () => {
    await handler(makeReq(), makeRes());
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'writing.explain_grammar',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        userId: 'user-123',
        initiatedByUserId: 'user-123',
        actorType: 'user',
        executionLocation: 'backend',
        isBillable: true,
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'grammar_explanation',
      }),
    );
  });

  it('records succeeded event', async () => {
    await handler(makeReq(), makeRes());
    expect(mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).not.toHaveBeenCalled();
  });

  it('records input_text_tokens and output_text_tokens from SDK response', async () => {
    await handler(makeReq(), makeRes());
    expect(mockInsertMetrics).toHaveBeenCalledTimes(1);
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    expect(metrics).toContainEqual(
      expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 100, isBillable: true }),
    );
    expect(metrics).toContainEqual(
      expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 50, isBillable: true }),
    );
  });

  it('records provider_requests = 1', async () => {
    await handler(makeReq(), makeRes());
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    expect(metrics).toContainEqual(
      expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }),
    );
  });

  it('records cached_input_tokens only when provided by SDK', async () => {
    const completionWithCache = {
      ...VALID_COMPLETION,
      usage: {
        ...VALID_COMPLETION.usage,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    };
    mockCreate.mockResolvedValue(completionWithCache);
    await handler(makeReq(), makeRes());
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    expect(metrics).toContainEqual(
      expect.objectContaining({ metricKey: 'cached_input_tokens', quantity: 40, isBillable: true }),
    );
  });

  it('does not record cached_input_tokens when not provided by SDK', async () => {
    await handler(makeReq(), makeRes()); // VALID_COMPLETION has no prompt_tokens_details
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    const cachedMetric = metrics.find((m: any) => m.metricKey === 'cached_input_tokens');
    expect(cachedMetric).toBeUndefined();
  });

  it('does not record cached_input_tokens when value is 0', async () => {
    const completionZeroCache = {
      ...VALID_COMPLETION,
      usage: {
        ...VALID_COMPLETION.usage,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    };
    mockCreate.mockResolvedValue(completionZeroCache);
    await handler(makeReq(), makeRes());
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    const cachedMetric = metrics.find((m: any) => m.metricKey === 'cached_input_tokens');
    expect(cachedMetric).toBeUndefined();
  });

  it('does not set calculatedCostUsd on any metric', async () => {
    await handler(makeReq(), makeRes());
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    for (const m of metrics) {
      expect((m as any).calculatedCostUsd).toBeUndefined();
    }
  });

  it('records provider_requests even when usage is absent', async () => {
    const completionNoUsage = { ...VALID_COMPLETION, usage: undefined };
    mockCreate.mockResolvedValue(completionNoUsage);
    await handler(makeReq(), makeRes());
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    expect(metrics).toContainEqual(
      expect.objectContaining({ metricKey: 'provider_requests', quantity: 1 }),
    );
    const tokenMetric = metrics.find((m: any) => m.metricKey === 'input_text_tokens');
    expect(tokenMetric).toBeUndefined();
  });
});

// ── OBSERVE mode — error ──────────────────────────────────────────────────────

describe('OBSERVE mode — provider error', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('calls OpenAI exactly once (no retry)', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    await handler(makeReq(), makeRes());
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('records failed event', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    await handler(makeReq(), makeRes());
    expect(mockFailEvent).toHaveBeenCalledTimes(1);
    expect(mockCompleteEvent).not.toHaveBeenCalled();
  });

  it('does not record metrics on error', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));
    await handler(makeReq(), makeRes());
    expect(mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('preserves error status code and does not leak internals', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), {
      constructor: { name: 'APIConnectionTimeoutError' },
    });
    timeoutErr.constructor.name = 'APIConnectionTimeoutError';
    mockCreate.mockRejectedValue(timeoutErr);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(504);
    expect((res._body() as any).code).toBe('AI_TIMEOUT');
  });
});

// ── Telemetry failure — must not break the call ───────────────────────────────

describe('telemetry failure resilience', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('still calls OpenAI and returns response when startEvent fails', async () => {
    mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ content: GRAMMAR_CONTENT, cached: false });
  });

  it('still returns response when completeEvent fails', async () => {
    mockCompleteEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('still returns response when insertMetrics fails', async () => {
    mockInsertMetrics.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });
});

// ── Cache hit ─────────────────────────────────────────────────────────────────

describe('cache hit', () => {
  beforeEach(() => {
    mockMaybeSingle.mockResolvedValue({ data: { content: GRAMMAR_CONTENT }, error: null });
    // Policy can be anything — cache hit returns before OpenAI call
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('does not call OpenAI', async () => {
    await handler(makeReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('records no telemetry', async () => {
    await handler(makeReq(), makeRes());
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('returns cached content with cached:true', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ content: GRAMMAR_CONTENT, cached: true });
  });
});

describe('plan entitlements gate', () => {
  it('blocks with FEATURE_DISABLED when writing.enabled is false, before the cache lookup or OpenAI', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);
    // Even a cache hit must never be reachable — writing.enabled gates the
    // whole endpoint, cached content included (see production comment).
    mockMaybeSingle.mockResolvedValue({ data: { content: GRAMMAR_CONTENT }, error: null });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
