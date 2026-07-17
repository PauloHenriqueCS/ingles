/**
 * Integration tests for api/review-text.ts — AI Gateway integration.
 *
 * Uses the real executeAiGatewayCall with injected mock deps so that the
 * full policy + telemetry path is exercised without real DB or OpenAI calls.
 *
 * Scope: only the physical openai.chat.completions.create(...) call inside
 * the retry loop is wrapped. Everything else (auth, rate limit, validation,
 * prompts, DB writes, response shape) is covered by src/lib/reviewText.test.ts
 * and must remain unaffected — this file only asserts gateway behavior.
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

import handler from '../review-text';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTRY_ID = '2026-01-15';
const REVIEW_GROUP_ID = 'cccccccc-0000-0000-0000-000000000001';

const VALID_AI_RESPONSE = JSON.stringify({
  score: 78,
  level: 'B1',
  grammar: 80,
  vocabulary: 75,
  naturalness: 78,
  fluency: 76,
  summary: 'Bom trabalho!',
  correctedText: 'Yesterday I went to the store.',
  mainMistakes: [{ original: 'goed', correct: 'went', explanation: 'went é o passado de go.' }],
  newVocabulary: [{ word: 'store', meaningPtBr: 'loja', example: 'I went to the store.' }],
  objectiveFeedback: 'Uso do Past Simple foi adequado.',
  nextPractice: 'Pratique mais tempos verbais irregulares.',
});

const REVIEW_AI_RESPONSE = JSON.stringify({
  score: 82,
  level: 'B1',
  grammar: 85,
  vocabulary: 80,
  naturalness: 82,
  fluency: 78,
  summary: 'Bom uso dos conectores!',
  correctedText: 'Although I was tired, I finished the task. Therefore, I was proud.',
  mainMistakes: [],
  newVocabulary: [{ word: 'proud', meaningPtBr: 'orgulhoso', example: 'I am proud of you.' }],
  objectiveFeedback: 'Usou although e therefore corretamente.',
  nextPractice: 'Tente usar moreover e however.',
  requiredWordEvaluation: [
    { requiredWord: 'therefore', status: 'correct', usedExcerpt: 'Therefore, I was proud.', explanation: 'Usou corretamente.', suggestedCorrection: null },
    { requiredWord: 'although', status: 'correct', usedExcerpt: 'Although I was tired', explanation: 'Usou corretamente.', suggestedCorrection: null },
  ],
});

/** Creates a chainable Supabase query stub that resolves to `result`. */
function makeChain(result: { data: unknown; error: unknown }) {
  const p = Promise.resolve(result);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'gte', 'lte', 'order']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.limit = vi.fn().mockReturnValue(p);
  c.single = vi.fn().mockReturnValue(p);
  c.maybeSingle = vi.fn().mockReturnValue(p);
  return c;
}

function makeDefaultSupabase() {
  const from = vi.fn((table: string) => {
    if (table === 'writing_entries') {
      return makeChain({ data: null, error: null });
    }
    if (table === 'review_groups') {
      return makeChain({ data: { id: REVIEW_GROUP_ID }, error: null });
    }
    if (table === 'review_group_items') {
      const p = Promise.resolve({
        data: [
          { id: 'item-1', original_value: 'therefor', corrected_value: 'therefore', explanation: null, original_sentence: null },
          { id: 'item-2', original_value: 'altough', corrected_value: 'although', explanation: null, original_sentence: null },
        ],
        error: null,
      });
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue(p) }) };
    }
    if (table === 'review_attempts') {
      return makeChain({ data: { id: 'attempt-1' }, error: null });
    }
    if (table === 'review_attempt_items') {
      return { insert: vi.fn().mockReturnValue(Promise.resolve({ data: null, error: null })) };
    }
    return makeChain({ data: null, error: null });
  });
  const rpc = vi.fn().mockResolvedValue({ data: { applied: true }, error: null });
  return { from, rpc };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: {
      entryId: ENTRY_ID,
      originalText: 'Yesterday I goed to the store.',
      theme: 'A trip to the store',
      grammarGoal: 'Past Simple',
      mainTense: 'Past Simple',
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

const reviewBody = {
  originalText: 'Although I was tired, I finished. Therefore, I was proud.',
  mode: 'review',
  reviewGroupId: REVIEW_GROUP_ID,
  missionTitle: 'Revisão de conectores',
  grammarGoal: 'Connectors',
  studentLevel: 'B1',
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  let eventCounter = 0;
  mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
  mockCreate.mockImplementation(() => aiOk(VALID_AI_RESPONSE));
  mockStartEvent.mockImplementation(() => Promise.resolve(`event-${++eventCounter}`));
  mockCompleteEvent.mockResolvedValue(undefined);
  mockFailEvent.mockResolvedValue(undefined);
  mockInsertMetrics.mockResolvedValue(undefined);
  // Default: no event found for costing, so reconcileEventCost no-ops safely.
  // Tests that specifically exercise cost calculation override these.
  mockGetEventForCosting.mockResolvedValue(null);
  mockGetMetricsForEvent.mockResolvedValue([]);
  mockUpdateMetricCost.mockResolvedValue(undefined);
  mockUpdateEventCost.mockResolvedValue(undefined);
  mockFindActivePrice.mockResolvedValue(null);
  mockRebuildBucketForEvent.mockResolvedValue('daily-bucket-1');
  mockRebuildBucket.mockResolvedValue('daily-bucket-1');
  mockListBucketsForDate.mockResolvedValue([]);
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeDefaultSupabase() });
  mockApplyRateLimit.mockResolvedValue(true);
  (mockDeps.clock as ReturnType<typeof vi.fn>).mockReturnValue(1000);
  (mockDeps.uuidGen as ReturnType<typeof vi.fn>).mockReturnValue('test-uuid');

  process.env.OPENAI_API_KEY = 'test-key';
});

// ── 1. LEGACY mode — normal correction ─────────────────────────────────────────

describe('LEGACY mode — normal correction', () => {
  it('returns the same response and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).feedback).toBeTruthy();
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(mockCompleteEvent).not.toHaveBeenCalled();
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(mockInsertMetrics).not.toHaveBeenCalled();
  });
});

// ── 2. OBSERVE mode — writing.correct, single physical call ───────────────────

describe('OBSERVE mode — writing.correct, single success', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event when there is one physical call', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('uses featureKey writing.correct with userId from auth (not from body)', async () => {
    await handler(makeReq({ body: { entryId: ENTRY_ID, originalText: 'Hello there.', userId: 'injected-evil' } }), makeRes());
    expect(mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'writing.correct',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        userId: USER_ID,
        initiatedByUserId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'writing_entry',
      }),
    );
  });
});

// ── 3. Three physical attempts → three events, shared correlationId ──────────

describe('OBSERVE mode — retry loop', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('two invalid JSON responses then success produce three events, no duplication', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_AI_RESPONSE));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockStartEvent).toHaveBeenCalledTimes(3);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(3);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('shares the same correlationId across all three attempts', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_AI_RESPONSE));

    await handler(makeReq(), makeRes());

    const correlationIds = mockStartEvent.mock.calls.map((c) => (c[0] as any).correlationId);
    expect(new Set(correlationIds).size).toBe(1);
  });

  it('increments attemptNumber per physical call (1, 2, 3)', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_AI_RESPONSE));

    await handler(makeReq(), makeRes());

    const attemptNumbers = mockStartEvent.mock.calls.map((c) => (c[0] as any).attemptNumber);
    expect(attemptNumbers).toEqual([1, 2, 3]);
  });

  it('three invalid-JSON attempts exhausted → 500, but all three events are recorded as succeeded (the physical call itself worked)', async () => {
    mockCreate.mockImplementation(() => aiOk('not json'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockStartEvent).toHaveBeenCalledTimes(3);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(3);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(500);
  });

  it('each of the three physical attempts gets its own independent cost calculation', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json', { prompt_tokens: 10, completion_tokens: 5 }))
      .mockImplementationOnce(() => aiOk('still not json', { prompt_tokens: 20, completion_tokens: 8 }))
      .mockImplementationOnce(() => aiOk(VALID_AI_RESPONSE, { prompt_tokens: 30, completion_tokens: 12 }));

    // Each event's metrics mirror exactly what was inserted for that eventId —
    // proves the three cost calculations are independent, not shared/merged.
    mockGetEventForCosting.mockImplementation(async (eventId: string) => ({
      id: eventId,
      provider: 'openai',
      service: 'chat.completions',
      model: 'gpt-4o-mini',
      startedAt: new Date(1000).toISOString(),
      costStatus: 'pending',
    }));
    mockGetMetricsForEvent.mockImplementation(async (eventId: string) => {
      const call = mockInsertMetrics.mock.calls.find((c) => c[0] === eventId);
      if (!call) return [];
      const metrics = call[1] as Array<{ metricKey: string; quantity: number; isBillable: boolean }>;
      return metrics.map((m, i) => ({ id: `${eventId}-metric-${i}`, metricKey: m.metricKey, quantity: m.quantity, isBillable: m.isBillable }));
    });
    mockFindActivePrice.mockResolvedValue({ id: 'price-1', pricePerUnit: '0.15', unitSize: '1000000', currency: 'USD' });

    await handler(makeReq(), makeRes());

    expect(mockStartEvent).toHaveBeenCalledTimes(3);

    // updateEventCost was called once per event (not merged into one call).
    expect(mockUpdateEventCost).toHaveBeenCalledTimes(3);
    const costedEventIds = mockUpdateEventCost.mock.calls.map((c) => c[0]);
    expect(new Set(costedEventIds).size).toBe(3);

    // Each event's total reflects only its own attempt's tokens (10/5, 20/8, 30/12),
    // not a running sum across attempts.
    const totals = mockUpdateEventCost.mock.calls.map((c) => (c[1] as any).calculatedCostUsd);
    expect(new Set(totals).size).toBe(3); // three distinct token counts -> three distinct totals
  });
});

// ── 4. Tokens per event ────────────────────────────────────────────────────────

describe('OBSERVE mode — token metrics per event', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('associates each response\'s own token usage with its own event', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json', { prompt_tokens: 10, completion_tokens: 5 }))
      .mockImplementationOnce(() => aiOk(VALID_AI_RESPONSE, { prompt_tokens: 200, completion_tokens: 80 }));

    await handler(makeReq(), makeRes());

    expect(mockInsertMetrics).toHaveBeenCalledTimes(2);
    const [eventId1, metrics1] = mockInsertMetrics.mock.calls[0];
    const [eventId2, metrics2] = mockInsertMetrics.mock.calls[1];

    expect(eventId1).not.toBe(eventId2);
    expect(metrics1).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 10 }));
    expect(metrics1).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 5 }));
    expect(metrics2).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 200 }));
    expect(metrics2).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 80 }));
  });

  it('does not set calculatedCostUsd on any metric', async () => {
    await handler(makeReq(), makeRes());
    const metrics: unknown[] = mockInsertMetrics.mock.calls[0][1];
    for (const m of metrics) {
      expect((m as any).calculatedCostUsd).toBeUndefined();
    }
  });
});

// ── 5. Review mode uses writing.correct_review ────────────────────────────────

describe('review mode featureKey', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    mockCreate.mockImplementation(() => aiOk(REVIEW_AI_RESPONSE));
  });

  it('spaced review submissions use featureKey writing.correct_review', async () => {
    const res = makeRes();
    await handler(makeReq({ body: reviewBody }), res);
    expect(res._status()).toBe(200);
    expect(mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: 'writing.correct_review' }),
    );
  });
});

// ── 6. Per-feature policy isolation ───────────────────────────────────────────

describe('per-feature policy isolation', () => {
  it('writing.correct_review stays legacy when only writing.correct is activated in observe', async () => {
    mockPolicyResolvePolicy.mockImplementation(async (ctx: any) =>
      ctx.featureKey === 'writing.correct'
        ? { gatewayMode: 'observe', runtimeStatus: 'enabled' }
        : { gatewayMode: 'legacy', runtimeStatus: 'enabled' },
    );
    mockCreate.mockImplementation(() => aiOk(REVIEW_AI_RESPONSE));

    const res = makeRes();
    await handler(makeReq({ body: reviewBody }), res);

    expect(res._status()).toBe(200);
    expect(mockStartEvent).not.toHaveBeenCalled();
  });

  it('writing.correct is observed while writing.correct_review remains legacy, in the same test run', async () => {
    mockPolicyResolvePolicy.mockImplementation(async (ctx: any) =>
      ctx.featureKey === 'writing.correct'
        ? { gatewayMode: 'observe', runtimeStatus: 'enabled' }
        : { gatewayMode: 'legacy', runtimeStatus: 'enabled' },
    );

    await handler(makeReq(), makeRes()); // normal mode
    expect(mockStartEvent).toHaveBeenCalledTimes(1);

    mockCreate.mockImplementation(() => aiOk(REVIEW_AI_RESPONSE));
    await handler(makeReq({ body: reviewBody }), makeRes()); // review mode
    expect(mockStartEvent).toHaveBeenCalledTimes(1); // unchanged — still just the one from normal mode
  });
});

// ── 7. Telemetry failure resilience ───────────────────────────────────────────

describe('telemetry failure resilience', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('still returns feedback when startEvent fails', async () => {
    mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('still returns feedback when completeEvent fails', async () => {
    mockCompleteEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('still returns feedback when insertMetrics fails', async () => {
    mockInsertMetrics.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });
});

// ── Daily rollup integration ────────────────────────────────────────────────

describe('daily rollup integration', () => {
  it('LEGACY mode never touches the daily rollup repository', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(mockRebuildBucketForEvent).not.toHaveBeenCalled();
  });

  describe('OBSERVE mode', () => {
    beforeEach(() => {
      mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    });

    it('rebuilds the bucket for the event once metrics are persisted', async () => {
      await handler(makeReq(), makeRes());
      expect(mockRebuildBucketForEvent).toHaveBeenCalledTimes(1);
      expect(mockRebuildBucketForEvent).toHaveBeenCalledWith('event-1');
    });

    it('a rollup failure never affects the response returned to the user', async () => {
      mockRebuildBucketForEvent.mockRejectedValue(new Error('advisory lock timeout'));
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).feedback).toBeTruthy();
    });

    it('a rollup failure is independent from cost calculation — cost still runs and is not blamed', async () => {
      mockRebuildBucketForEvent.mockRejectedValue(new Error('rollup exploded'));
      await handler(makeReq(), makeRes());
      // getEventForCosting is the first call cost calculation makes — proves
      // cost calculation still ran despite the rollup failure that follows it.
      expect(mockGetEventForCosting).toHaveBeenCalledTimes(1);
    });

    it('a cost-calculation failure does not prevent the daily rollup from running', async () => {
      mockGetEventForCosting.mockRejectedValue(new Error('pricing DB down'));
      await handler(makeReq(), makeRes());
      expect(mockRebuildBucketForEvent).toHaveBeenCalledTimes(1);
    });

    it('three physical attempts rebuild three independent buckets, one per event', async () => {
      mockCreate
        .mockImplementationOnce(() => aiOk('not json'))
        .mockImplementationOnce(() => aiOk('still not json'))
        .mockImplementationOnce(() => aiOk(VALID_AI_RESPONSE));

      await handler(makeReq(), makeRes());

      expect(mockRebuildBucketForEvent).toHaveBeenCalledTimes(3);
      const eventIdsRolledUp = mockRebuildBucketForEvent.mock.calls.map((c) => c[0]);
      expect(new Set(eventIdsRolledUp).size).toBe(3);
    });
  });
});

// ── 8. OpenAI error preserves current behavior ────────────────────────────────

describe('provider error behavior is unchanged', () => {
  it('LEGACY: timeout returns 504 with no retry', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const timeoutErr = Object.assign(new Error('timeout'), { constructor: { name: 'APIConnectionTimeoutError' } });
    timeoutErr.constructor.name = 'APIConnectionTimeoutError';
    mockCreate.mockRejectedValue(timeoutErr);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(504);
  });

  it('OBSERVE: timeout returns 504 with no retry, and records a failed event', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const timeoutErr = Object.assign(new Error('timeout'), { constructor: { name: 'APIConnectionTimeoutError' } });
    timeoutErr.constructor.name = 'APIConnectionTimeoutError';
    mockCreate.mockRejectedValue(timeoutErr);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(504);
    expect(mockFailEvent).toHaveBeenCalledTimes(1);
    expect(mockCompleteEvent).not.toHaveBeenCalled();
  });

  it('OBSERVE: 500-class provider error returns 503 (AI_UNAVAILABLE), no retry', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    mockCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(503);
  });
});

// ── 9. Auth and rate limit continue to gate the request ──────────────────────

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
    expect(mockApplyRateLimit).toHaveBeenCalledWith(expect.anything(), USER_ID, 'review-text');
  });
});

// ── 10. No student text or prompt content in metadata ─────────────────────────

describe('metadata never leaks student content', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('startEvent metadata contains only allowlisted technical fields', async () => {
    const secretText = 'Yesterday I goed to the very secret confidential store of doom.';
    await handler(
      makeReq({ body: { entryId: ENTRY_ID, originalText: secretText, theme: 'Trip', grammarGoal: 'Past', mainTense: 'Past Simple' } }),
      makeRes(),
    );

    const startCall = mockStartEvent.mock.calls[0][0] as any;
    const metadataStr = JSON.stringify(startCall.metadata);

    expect(metadataStr).not.toContain('goed');
    expect(metadataStr).not.toContain('secret');
    expect(metadataStr).not.toContain('confidential');
    expect(Object.keys(startCall.metadata).sort()).toEqual(['attempt', 'endpoint', 'flowType', 'maxAttempts'].sort());
    expect(startCall.metadata).toEqual({
      endpoint: 'review-text',
      flowType: 'normal',
      attempt: 1,
      maxAttempts: 3,
    });
  });

  it('review mode metadata carries flowType "review", still no submitted text', async () => {
    mockCreate.mockImplementation(() => aiOk(REVIEW_AI_RESPONSE));
    await handler(makeReq({ body: reviewBody }), makeRes());

    const startCall = mockStartEvent.mock.calls[0][0] as any;
    expect(startCall.metadata.flowType).toBe('review');
    expect(JSON.stringify(startCall.metadata)).not.toContain('tired');
    expect(JSON.stringify(startCall.metadata)).not.toContain('proud');
  });

  it('does not include the OpenAI API key or auth token anywhere in the start payload', async () => {
    await handler(makeReq(), makeRes());
    const startCall = mockStartEvent.mock.calls[0][0] as any;
    const payloadStr = JSON.stringify(startCall);
    expect(payloadStr).not.toContain('test-key');
    expect(payloadStr).not.toContain('test-token');
  });
});
