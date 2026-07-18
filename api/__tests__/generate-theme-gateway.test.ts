/**
 * Integration tests for api/generate-theme.ts — AI Gateway integration.
 *
 * Uses the real executeAiGatewayCall with injected mock deps so the full
 * policy + telemetry path is exercised without real DB or OpenAI calls.
 *
 * Diagnostic mode, the pedagogical planner, and the mission validator are
 * mocked out entirely (their own correctness is out of scope here) so most
 * tests exercise the plain "normal mode" 3-attempt loop deterministically.
 * Dedicated tests exercise the diagnostic and review phases specifically.
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
  mockPolicyResolvePolicy,
  mockRequireAuth,
  mockApplyRateLimit,
  mockGetDiagnosticContext,
  mockGetCurrentUserPlanEntitlements,
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
  const mockPolicyResolvePolicy = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockApplyRateLimit = vi.fn();
  const mockGetDiagnosticContext = vi.fn();
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
      getEventForCosting: mockGetEventForCosting,
      getMetricsForEvent: mockGetMetricsForEvent,
      updateMetricCost: mockUpdateMetricCost,
      updateEventCost: mockUpdateEventCost,
    },
    pricingRepository: { findActivePrice: mockFindActivePrice },
    dailyRollupRepository: {
      rebuildBucketForEvent: mockRebuildBucketForEvent,
      rebuildBucket: vi.fn(),
      listBucketsForDate: vi.fn().mockResolvedValue([]),
    },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
  };

  return {
    mockCreate, mockStartEvent, mockCompleteEvent, mockFailEvent, mockInsertMetrics,
    mockGetEventForCosting, mockGetMetricsForEvent, mockUpdateMetricCost, mockUpdateEventCost,
    mockFindActivePrice, mockRebuildBucketForEvent, mockPolicyResolvePolicy, mockRequireAuth,
    mockApplyRateLimit, mockGetDiagnosticContext, mockGetCurrentUserPlanEntitlements, mockDeps,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────
// Real executeAiGatewayCall is used; only getProductionDeps is replaced.
vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => mockDeps };
});

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit }));

// Plan entitlements — permissive by default (writing enabled + unlimited),
// matching current unrestricted behavior; individual tests override
// mockGetCurrentUserPlanEntitlements to exercise blocking.
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

// Diagnostic mode — off by default; individual tests override mockGetDiagnosticContext.
vi.mock('../_diagnostic-service', () => ({
  getDiagnosticGenerationContext: mockGetDiagnosticContext,
  saveDiagnosticMission: vi.fn(),
  logDiagnosticEvent: vi.fn(),
  validateGeneratedDiagnosticMission: vi.fn().mockReturnValue({ valid: true, updatedLog: [] }),
}));
vi.mock('../_diagnostic-dto', () => ({ toPublicMissionDTO: (t: unknown) => t }));
vi.mock('../_diagnostic-prompt', () => ({
  DIAGNOSTIC_SYSTEM_PROMPT_EXTENSION: '',
  buildDiagnosticUserMessageSection: () => '',
}));

// Pedagogical planner integration — off by default (no plan injected, no validator).
vi.mock('../_mission-generator-feature-flags', () => ({
  isGeneratorIntegrationEnabled: () => false,
  isGeneratorIntegrationFullyActive: () => false,
  isMissionValidatorActive: () => false,
  isMissionValidatorEnforcing: () => false,
}));
vi.mock('../_mission-plan-service', () => ({ generatePedagogicalPlan: vi.fn() }));
vi.mock('../_mission-prompt-builder', () => ({
  buildPlanConstraintsSection: () => '',
  buildRepairSection: () => '',
}));
vi.mock('../../src/domain/missions/mission-validator', () => ({
  validateMissionAgainstPedagogicalPlan: () => ({ valid: true }),
}));
vi.mock('../../src/domain/missions/mission-fallback', () => ({
  selectFallbackTemplate: () => ({ id: 'template-1' }),
  buildFallbackCandidate: () => ({}),
}));

// ── Handler import ────────────────────────────────────────────────────────────

import handler from '../generate-theme';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function themeJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: 'Proposta ao gerente',
    missionSetup: 'Seu gerente pediu uma ideia.',
    missionTask: 'Escreva um e-mail explicando sua proposta.',
    mission: 'Seu gerente pediu uma ideia. Escreva um e-mail explicando sua proposta.',
    themeEn: 'Write an email to your manager.',
    format: 'e-mail',
    context: 'trabalho',
    conflict: 'precisou convencer alguém',
    objective: 'convencer',
    semanticSummary: 'Formato: e-mail | Conflito: precisou convencer alguém | Objetivo: convencer',
    whyThisActivity: 'Pratica e-mails formais.',
    level: 'B1',
    difficulty: 'medium',
    estimatedTimeMinutes: 15,
    requiredGrammar: ['Present Perfect'],
    suggestedVocabulary: [],
    useTheseWords: [],
    instructions: [],
    exampleSentence: '',
    successCriteria: [],
    extraChallenge: '',
    category: 'work',
    grammarTips: {},
    responseExamples: [],
    ...overrides,
  });
}

const VALID_THEME_JSON = themeJson();
const DIFFERENT_FORMAT_THEME_JSON = themeJson({ format: 'diário', activityType: 'diário' });

function makeChain(result: { data: unknown; error: unknown }) {
  const p = Promise.resolve(result);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'order']) c[m] = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockReturnValue(p);
  c.single = vi.fn().mockReturnValue(p);
  c.maybeSingle = vi.fn().mockReturnValue(p);
  return c;
}

function makeDefaultSupabase(recentThemes: unknown[] = []) {
  const from = vi.fn((table: string) => {
    if (table === 'generated_themes') {
      return {
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: recentThemes, error: null }) }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'theme-1' }, error: null }) }) }),
      };
    }
    return makeChain({ data: null, error: null });
  });
  return { from };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: { learningContext: {} },
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
    usage: usage ?? { prompt_tokens: 200, completion_tokens: 300, total_tokens: 500 },
  });
}

// ── Plan entitlements fixture ──────────────────────────────────────────────────

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

  let eventCounter = 0;
  mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
  mockCreate.mockImplementation(() => aiOk(VALID_THEME_JSON));
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
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeDefaultSupabase() });
  mockApplyRateLimit.mockResolvedValue(true);
  mockGetDiagnosticContext.mockResolvedValue({ shouldUseDiagnostic: false });
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  (mockDeps.clock as ReturnType<typeof vi.fn>).mockReturnValue(1000);
  (mockDeps.uuidGen as ReturnType<typeof vi.fn>).mockReturnValue('test-uuid');

  process.env.OPENAI_API_KEY = 'test-key';
});

// ── 1. LEGACY mode ──────────────────────────────────────────────────────────────

describe('LEGACY mode', () => {
  it('returns the theme and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).theme).toBeTruthy();
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(mockCompleteEvent).not.toHaveBeenCalled();
    expect(mockInsertMetrics).not.toHaveBeenCalled();
    expect(mockRebuildBucketForEvent).not.toHaveBeenCalled();
    expect(mockFindActivePrice).not.toHaveBeenCalled();
  });
});

// ── 2. OBSERVE — single success ──────────────────────────────────────────────

describe('OBSERVE mode — single success', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('generates exactly one event for a first-attempt success', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('uses featureKey writing.generate_topic with userId/model/service from context', async () => {
    await handler(makeReq(), makeRes());
    expect(mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'writing.generate_topic',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        userId: USER_ID,
        initiatedByUserId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
      }),
    );
  });
});

// ── 3/4/5. Multiple physical calls — correlationId shared, attemptNumber grows ─

describe('OBSERVE mode — retry loop (normal phase)', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('two invalid-JSON responses then success produce three events, all succeeded', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockStartEvent).toHaveBeenCalledTimes(3);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(3);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('shares the same correlationId across all physical attempts', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON));

    await handler(makeReq(), makeRes());

    const correlationIds = mockStartEvent.mock.calls.map((c) => (c[0] as any).correlationId);
    expect(new Set(correlationIds).size).toBe(1);
  });

  it('attemptNumber increases globally (1, 2, 3), matching physicalAttempt', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON));

    await handler(makeReq(), makeRes());

    const attemptNumbers = mockStartEvent.mock.calls.map((c) => (c[0] as any).attemptNumber);
    expect(attemptNumbers).toEqual([1, 2, 3]);
  });
});

// ── 6. Similarity-rejected response is still a succeeded event ────────────────

describe('similarity rejection does not change event status', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    // recentThemes[0] has the exact same format as the first AI candidate —
    // isTooSimilar's hard rule rejects it deterministically.
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: makeDefaultSupabase([
        { title: 'Old mission', activity_type: 'e-mail', context: 'trabalho', semantic_summary: 'Formato: e-mail | Conflito: x | Objetivo: y' },
      ]),
    });
  });

  it('a valid-JSON, similarity-rejected attempt is recorded as succeeded, not failed', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON)) // format: e-mail -> rejected by similarity
      .mockImplementationOnce(() => aiOk(DIFFERENT_FORMAT_THEME_JSON)); // format: diário -> accepted

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockStartEvent).toHaveBeenCalledTimes(2);
    expect(mockCompleteEvent).toHaveBeenCalledTimes(2); // both succeeded
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });
});

// ── 7. JSON rejected by the application is still a succeeded event ────────────

describe('invalid JSON does not change event status', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('an unparsable response is recorded as succeeded — the physical call itself worked', async () => {
    mockCreate.mockImplementationOnce(() => aiOk('not json at all')).mockImplementationOnce(() => aiOk(VALID_THEME_JSON));
    await handler(makeReq(), makeRes());
    expect(mockCompleteEvent).toHaveBeenCalledTimes(2);
    expect(mockFailEvent).not.toHaveBeenCalled();
  });
});

// ── 8/9. Real provider error → failed event, retry behavior unchanged ─────────

describe('provider error behavior', () => {
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

  it('OBSERVE: timeout returns 504, no retry, records exactly one failed event', async () => {
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

  it('a non-timeout/non-unavailable provider error still retries up to MAX_ATTEMPTS like before', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    // Plain validation-style rejection path: JSON invalid on every attempt exhausts retries -> 500.
    mockCreate.mockImplementation(() => aiOk('not json'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS in normal mode
    expect(res._status()).toBe(500);
  });
});

// ── 10. Tokens per event ────────────────────────────────────────────────────────

describe('token metrics per event', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it("associates each response's own token usage with its own event", async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json', { prompt_tokens: 10, completion_tokens: 5 }))
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON, { prompt_tokens: 400, completion_tokens: 250 }));

    await handler(makeReq(), makeRes());

    expect(mockInsertMetrics).toHaveBeenCalledTimes(2);
    const metrics1 = mockInsertMetrics.mock.calls[0][1];
    const metrics2 = mockInsertMetrics.mock.calls[1][1];
    expect(metrics1).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 10 }));
    expect(metrics2).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 400 }));
  });
});

// ── 11. cached_input_tokens is billable and not double-charged ────────────────

describe('cached_input_tokens metric', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('is emitted as billable, alongside (not instead of) the full input_text_tokens report', async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.resolve({
        choices: [{ message: { content: VALID_THEME_JSON } }],
        usage: { prompt_tokens: 500, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } },
      }),
    );
    await handler(makeReq(), makeRes());

    const metrics = mockInsertMetrics.mock.calls[0][1];
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 500, isBillable: true }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'cached_input_tokens', quantity: 200, isBillable: true }));
    // Splitting the regular vs. cached share (no double charge) is the cost
    // calculator's job (Etapa 6) — already covered by cost-calculator.test.ts.
  });

  it('provider_requests is emitted as non-billable', async () => {
    await handler(makeReq(), makeRes());
    const metrics = mockInsertMetrics.mock.calls[0][1];
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
  });
});

// ── 12/13. Cost and daily rollup per physical call ─────────────────────────────

describe('cost calculation and daily rollup per physical call', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('cost calculation is attempted independently for each of three physical events', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON));

    await handler(makeReq(), makeRes());

    expect(mockGetEventForCosting).toHaveBeenCalledTimes(3);
    const costedIds = mockGetEventForCosting.mock.calls.map((c) => c[0]);
    expect(new Set(costedIds).size).toBe(3);
  });

  it('the daily bucket is rebuilt once per physical event (3 physical calls -> 3 rebuilds, 1 logical request)', async () => {
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))
      .mockImplementationOnce(() => aiOk('still not json'))
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON));

    await handler(makeReq(), makeRes());

    expect(mockRebuildBucketForEvent).toHaveBeenCalledTimes(3);
    const rolledUpIds = mockRebuildBucketForEvent.mock.calls.map((c) => c[0]);
    expect(new Set(rolledUpIds).size).toBe(3);
    // usage_daily.total_requests / distinct_logical_requests semantics (3
    // physical, 1 logical via the shared correlationId) live in the SQL
    // aggregation validated in Etapa 7 — this only proves three independent
    // rebuild calls happened, one per physical event.
  });
});

// ── 14/15/16. Telemetry, cost, and rollup failures never break generation ────

describe('failure resilience', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('startEvent failure does not break generation', async () => {
    mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('cost calculation failure does not break generation', async () => {
    mockGetEventForCosting.mockRejectedValue(new Error('pricing DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
  });

  it('daily rollup failure does not break generation', async () => {
    mockRebuildBucketForEvent.mockRejectedValue(new Error('advisory lock timeout'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).theme).toBeTruthy();
  });
});

// ── 17. Cache / no-OpenAI path never creates a billable event ─────────────────

describe('existing-mission shortcut (no physical call)', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('returning an existing diagnostic mission never calls OpenAI or creates telemetry', async () => {
    mockGetDiagnosticContext.mockResolvedValue({
      shouldUseDiagnostic: true,
      diagnosticSequence: 1,
      existingActiveMission: { theme_id: 'existing-theme-1' },
      diagnosticPlan: null,
    });
    const supa = makeDefaultSupabase();
    (supa.from as any) = vi.fn((table: string) => {
      if (table === 'generated_themes') {
        return {
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'existing-theme-1', title: 'Old', description: 'desc', activity_type: 'e-mail', context: 'trabalho', semantic_summary: '', difficulty: 'easy', vocabulary: [], grammar_focus: [] },
                  error: null,
                }),
              }),
            }),
          }),
          insert: vi.fn(),
        };
      }
      return makeChain({ data: null, error: null });
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: supa });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
    expect((res._body() as any).themeId).toBe('existing-theme-1');
  });
});

// ── 18. user_id matches the authenticated user ─────────────────────────────────

describe('user isolation', () => {
  it('userId in the gateway context comes from auth, never from the body', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    await handler(makeReq({ body: { learningContext: {}, userId: 'injected-evil' } }), makeRes());
    expect(mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
  });
});

// ── 19. Metadata never leaks subject, prompt, or generated theme ──────────────

describe('metadata never leaks generation content', () => {
  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('technicalMetadata contains only allowlisted technical fields', async () => {
    await handler(makeReq({ body: { learningContext: {}, selectedTheme: 'a very specific secret subject the student picked' } }), makeRes());

    const startCall = mockStartEvent.mock.calls[0][0] as any;
    expect(Object.keys(startCall.metadata).sort()).toEqual(
      ['endpoint', 'flowType', 'maxPhysicalAttempts', 'phase', 'phaseAttempt', 'physicalAttempt'].sort(),
    );
    const metadataStr = JSON.stringify(startCall.metadata);
    expect(metadataStr).not.toContain('secret subject');
    expect(metadataStr).not.toContain('Proposta ao gerente'); // theme title
    expect(startCall.metadata).toEqual({
      endpoint: 'generate-theme',
      phase: 'normal',
      phaseAttempt: 1,
      physicalAttempt: 1,
      maxPhysicalAttempts: 3,
      flowType: 'normal',
    });
  });

  it('does not include the OpenAI API key or auth token anywhere in the start payload', async () => {
    await handler(makeReq(), makeRes());
    const payloadStr = JSON.stringify(mockStartEvent.mock.calls[0][0]);
    expect(payloadStr).not.toContain('test-key');
    expect(payloadStr).not.toContain('test-token');
  });
});

// ── 20. generated_themes persistence is unaffected ────────────────────────────

describe('generated_themes persistence unchanged', () => {
  it('still persists the generated theme in both legacy and observe', async () => {
    for (const gatewayMode of ['legacy', 'observe'] as const) {
      mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode, runtimeStatus: 'enabled' });
      const insertSpy = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'theme-x' }, error: null }) }) });
      const supa = makeDefaultSupabase();
      (supa.from as any) = vi.fn((table: string) => {
        if (table === 'generated_themes') {
          return {
            update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
            select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) }),
            insert: insertSpy,
          };
        }
        return makeChain({ data: null, error: null });
      });
      mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: supa });

      const res = makeRes();
      await handler(makeReq(), res);

      expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({
        user_id: USER_ID,
        title: 'Proposta ao gerente',
        status: 'generated',
      }));
      expect((res._body() as any).themeId).toBe('theme-x');
    }
  });
});

// ── 21. Auth and rate limit still gate the request ────────────────────────────

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
    expect(mockApplyRateLimit).toHaveBeenCalledWith(expect.anything(), USER_ID, 'generate-theme');
  });
});

// ── Review phase uses the same featureKey and its own MAX_REVIEW_ATTEMPTS ─────

describe('review phase', () => {
  const REVIEW_JSON = JSON.stringify({
    title: 'Revisão', missionSetup: 'x', missionTask: 'y', mission: 'x y', themeEn: 'z',
    objective: 'practice', activityType: 'narrative', format: 'narrative', context: 'work',
    conflict: '', semanticSummary: 'Formato: narrative | Objetivo: practice', level: 'B1',
    difficulty: 'easy', estimatedTimeMinutes: 15, requiredGrammar: [], requiredWords: ['therefore'],
    suggestedVocabulary: [], useTheseWords: [], instructions: [], exampleSentence: '',
    successCriteria: [], extraChallenge: '', category: 'review', grammarTips: {},
    responseExamples: [], mode: 'review', reviewGroupId: 'group-1',
  });

  beforeEach(() => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    mockCreate.mockImplementation(() => aiOk(REVIEW_JSON));
  });

  it('uses featureKey writing.generate_topic with phase "review" and flowType "review"', async () => {
    await handler(
      makeReq({
        body: {
          mode: 'review',
          reviewGroup: { group: { id: 'group-1', originalTheme: null, sourceEntryDate: null, reviewLevel: 1 }, items: [{ originalValue: 'therefor', correctedValue: 'therefore', explanation: null, originalSentence: null }] },
          learningContext: { currentLevel: 'B1' },
        },
      }),
      makeRes(),
    );

    expect(mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ featureKey: 'writing.generate_topic' }));
    const meta = (mockStartEvent.mock.calls[0][0] as any).metadata;
    expect(meta.phase).toBe('review');
    expect(meta.flowType).toBe('review');
    expect(meta.maxPhysicalAttempts).toBe(3);
  });
});

// ── Diagnostic phase attemptNumber continues into normal phase ────────────────

describe('diagnostic phase falling through to normal phase', () => {
  it('physicalAttempt keeps counting from the diagnostic phase into the normal phase, without resetting', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    mockGetDiagnosticContext.mockResolvedValue({
      shouldUseDiagnostic: true,
      diagnosticSequence: 1,
      existingActiveMission: null,
      diagnosticPlan: { objectives: [] },
    });
    // Both diagnostic attempts fail validation (invalid JSON) -> falls through to normal mode.
    mockCreate
      .mockImplementationOnce(() => aiOk('not json'))     // diagnostic attempt 1
      .mockImplementationOnce(() => aiOk('not json'))     // diagnostic attempt 2 (MAX_DIAGNOSTIC_GENERATION_ATTEMPTS)
      .mockImplementationOnce(() => aiOk(VALID_THEME_JSON)); // normal attempt 1

    await handler(makeReq(), makeRes());

    expect(mockStartEvent).toHaveBeenCalledTimes(3);
    const calls = mockStartEvent.mock.calls.map((c) => c[0] as any);
    expect(calls.map((c) => c.attemptNumber)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.metadata.phase)).toEqual(['diagnostic', 'diagnostic', 'normal']);
    expect(calls.map((c) => c.metadata.physicalAttempt)).toEqual([1, 2, 3]);
    // phaseAttempt resets per phase — only physicalAttempt is global.
    expect(calls.map((c) => c.metadata.phaseAttempt)).toEqual([1, 2, 1]);
    // correlationId is identical across the phase change.
    expect(new Set(calls.map((c) => c.correlationId)).size).toBe(1);
  });
});

// ── Plan entitlements enforcement ──────────────────────────────────────────────

describe('plan entitlements enforcement', () => {
  it('returns 403 FEATURE_DISABLED and never calls OpenAI when writing is disabled by the plan', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
  });

  it('returns 403 DAILY_LIMIT_REACHED and never calls OpenAI once the daily generation limit is exhausted', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.themeGenerations = {
      enabled: true, unlimited: false, limit: 2, consumed: 2, remaining: 0, period: 'day', state: 'daily_limit_reached', canStart: false,
    };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
  });

  it('allows generation through when writing is enabled and generations remain', async () => {
    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('does not block the diagnostic "reuse existing mission" shortcut on the daily generation limit', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.themeGenerations = {
      enabled: true, unlimited: false, limit: 1, consumed: 1, remaining: 0, period: 'day', state: 'daily_limit_reached', canStart: false,
    };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);
    mockGetDiagnosticContext.mockResolvedValue({
      shouldUseDiagnostic: true,
      diagnosticSequence: 1,
      existingActiveMission: { theme_id: 'existing-theme-1' },
      diagnosticPlan: null,
    });
    const supa = makeDefaultSupabase();
    (supa.from as any) = vi.fn((table: string) => {
      if (table === 'generated_themes') {
        return {
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'existing-theme-1', title: 'Old', description: 'desc', activity_type: 'e-mail', context: 'trabalho', semantic_summary: '', difficulty: 'easy', vocabulary: [], grammar_focus: [] },
                  error: null,
                }),
              }),
            }),
          }),
          insert: vi.fn(),
        };
      }
      return makeChain({ data: null, error: null });
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: supa });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
    expect((res._body() as any).themeId).toBe('existing-theme-1');
  });

  it('resolves entitlements from the authenticated userId, never from the request body', async () => {
    await handler(makeReq({ body: { learningContext: {}, userId: 'injected-evil', planId: 'injected-plan' } }), makeRes());
    expect(mockGetCurrentUserPlanEntitlements).toHaveBeenCalledWith(USER_ID);
  });

  it('returns 500 INTERNAL_ERROR and never calls OpenAI when entitlement resolution itself fails', async () => {
    mockGetCurrentUserPlanEntitlements.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(res._status()).toBe(500);
  });
});
