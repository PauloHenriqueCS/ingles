/**
 * Unit tests for api/_ai-gateway/enforcement.ts — the enforce-mode pipeline
 * (Etapa 11, Fase 5/11/15, corrected per the "close enforcement readiness
 * gaps" follow-up, and again per the P0 budget-enforcement fix). NOTE: the
 * "unreachable in production" framing below predates
 * 20260723050000_gateway_global_runtime_control_activation.sql /
 * 20260723060000_kill_switch_runtime_controls_fix.sql (ingles-dashboad) —
 * gateway_mode is now 'enforce' for the real provider/feature rows in
 * production, so this pipeline is live. "não fingir proteção forte" cuts
 * both ways: the code must be real, not just the refusal to activate it.
 *
 * Mocks every repository/RPC-wrapper interface directly (no real Postgres —
 * see supabase/manual-validation/ai-gateway-enforcement-concurrency.sql for
 * the concurrency-dependent scenarios that genuinely require a live
 * database and are validated there instead, honestly declared per Fase 15).
 * The "acceptance scenario" test below uses a stateful mock reservations
 * repository to prove the TS layer builds/wires the right request — the
 * underlying atomicity guarantee itself is a SQL-level property (row locks
 * in reserve_gateway_usage_v1), validated by reasoning + the manual SQL
 * file, not by this mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeEnforcedPipeline } from '../_ai-gateway/enforcement';
import { GatewayError } from '../_ai-gateway/errors';
import { calculateLineCostUsd } from '../_ai-gateway/decimal';
import type { GatewayDeps } from '../_ai-gateway/gateway';
import type { GatewayCallContext, GatewayPolicy, EffectiveEntitlement, ReserveUsageParams, ReservationResult } from '../_ai-gateway/types';

function basePolicy(overrides: Partial<GatewayPolicy> = {}): GatewayPolicy {
  return { gatewayMode: 'enforce', runtimeStatus: 'enabled', ...overrides };
}

function baseContext(overrides: Partial<GatewayCallContext> = {}): GatewayCallContext {
  return {
    featureKey: 'writing.correct',
    provider: 'openai',
    actorType: 'user',
    executionLocation: 'backend',
    userId: 'user-123',
    ...overrides,
  };
}

function allowedEntitlement(overrides: Partial<EffectiveEntitlement> = {}): EffectiveEntitlement {
  return {
    allowed: true, userId: 'user-123', actorType: 'user', featureKey: 'writing.correct',
    effectivePlanId: null, limits: [], source: 'no_plan_configured', revision: null,
    resolvedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeDeps(): GatewayDeps & {
  startEvent: ReturnType<typeof vi.fn>;
  completeEvent: ReturnType<typeof vi.fn>;
  failEvent: ReturnType<typeof vi.fn>;
  insertMetrics: ReturnType<typeof vi.fn>;
  entitlementResolve: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  rateLimiterCheck: ReturnType<typeof vi.fn>;
  dedupeBegin: ReturnType<typeof vi.fn>;
  dedupeComplete: ReturnType<typeof vi.fn>;
  dedupeFail: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  markReconciliationRequired: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
  decisionsRecord: ReturnType<typeof vi.fn>;
} {
  const startEvent = vi.fn().mockResolvedValue('event-1');
  const completeEvent = vi.fn().mockResolvedValue(undefined);
  const failEvent = vi.fn().mockResolvedValue(undefined);
  const insertMetrics = vi.fn().mockResolvedValue(undefined);
  const entitlementResolve = vi.fn().mockResolvedValue(allowedEntitlement());
  const getState = vi.fn().mockResolvedValue({ state: 'closed', probeAllowed: true });
  const rateLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  const dedupeBegin = vi.fn().mockResolvedValue({ lockId: 'lock-1', outcome: 'started', resultRef: null });
  const dedupeComplete = vi.fn().mockResolvedValue(undefined);
  const dedupeFail = vi.fn().mockResolvedValue(undefined);
  const reserve = vi.fn().mockResolvedValue({ reservationId: 'res-1', status: 'pending', expiresAt: new Date(1000).toISOString(), blockedReason: null, blockedDetail: null });
  const commit = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  const markReconciliationRequired = vi.fn().mockResolvedValue(undefined);
  const recordOutcome = vi.fn().mockResolvedValue('closed');
  const decisionsRecord = vi.fn().mockResolvedValue(undefined);

  return {
    policyResolver: { resolvePolicy: vi.fn(), invalidate: vi.fn() },
    usageRepository: {
      startEvent, completeEvent, failEvent, cancelEvent: vi.fn(), insertMetrics,
      createProviderSession: vi.fn(), activateSession: vi.fn(), completeSession: vi.fn(),
      failSession: vi.fn(), expireSession: vi.fn(),
      getEventForCosting: vi.fn().mockResolvedValue(null), getMetricsForEvent: vi.fn().mockResolvedValue([]),
      updateMetricCost: vi.fn(), updateEventCost: vi.fn(),
    } as any,
    pricingRepository: { findActivePrice: vi.fn().mockResolvedValue(null) },
    dailyRollupRepository: { rebuildBucketForEvent: vi.fn().mockResolvedValue('bucket-1'), rebuildBucket: vi.fn(), listBucketsForDate: vi.fn() },
    decisionsRepository: { record: decisionsRecord },
    entitlementResolver: { resolve: entitlementResolve },
    rateLimiter: { check: rateLimiterCheck },
    dedupeStore: { begin: dedupeBegin, complete: dedupeComplete, fail: dedupeFail },
    reservationsRepository: { reserve, commit, release, markReconciliationRequired },
    circuitBreaker: { getState, recordOutcome },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
    startEvent, completeEvent, failEvent, insertMetrics,
    entitlementResolve, getState, rateLimiterCheck, dedupeBegin, dedupeComplete, dedupeFail,
    reserve, commit, release, markReconciliationRequired, recordOutcome, decisionsRecord,
  };
}

async function expectGatewayError(promise: Promise<unknown>, code: string): Promise<GatewayError> {
  try {
    await promise;
    throw new Error('expected promise to reject');
  } catch (err) {
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe(code);
    return err as GatewayError;
  }
}

describe('executeEnforcedPipeline', () => {
  let deps: ReturnType<typeof makeDeps>;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deps = makeDeps();
    invoke = vi.fn().mockResolvedValue('ok');
  });

  // ── 1. Entitlement ──────────────────────────────────────────────────────

  it('fails closed with POLICY_UNAVAILABLE when no entitlement resolver is configured', async () => {
    delete (deps as any).entitlementResolver;
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy()), 'POLICY_UNAVAILABLE');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed with POLICY_UNAVAILABLE when entitlement resolution itself failed (source=fallback_error)', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ source: 'fallback_error' }));
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy()), 'POLICY_UNAVAILABLE');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blocks with USER_BLOCKED when the entitlement resolver says allowed=false', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ allowed: false }));
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy()), 'USER_BLOCKED');
    expect(invoke).not.toHaveBeenCalled();
  });

  // ── 2. Circuit breaker gate (moved before rate limit/dedupe/reserve) ────

  it('blocks with CIRCUIT_OPEN before rate limit/dedupe/reserve/provider when the breaker denies a probe', async () => {
    deps.getState.mockResolvedValue({ state: 'open', probeAllowed: false });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy()), 'CIRCUIT_OPEN');
    expect(invoke).not.toHaveBeenCalled();
    expect(deps.rateLimiterCheck).not.toHaveBeenCalled();
    expect(deps.dedupeBegin).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.startEvent).not.toHaveBeenCalled();
  });

  it('allows a probe through in half_open state', async () => {
    deps.getState.mockResolvedValue({ state: 'half_open', probeAllowed: true });
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).resolves.toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('fails closed with POLICY_UNAVAILABLE when the breaker state check itself throws', async () => {
    deps.getState.mockRejectedValue(new Error('rpc missing'));
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy()), 'POLICY_UNAVAILABLE');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips the breaker gate entirely when no circuitBreaker is configured (legacy-safe)', async () => {
    delete (deps as any).circuitBreaker;
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).resolves.toBe('ok');
  });

  // ── 3. Rate limit ────────────────────────────────────────────────────────

  it('skips the rate limiter entirely when policy has no configured rate limit (rateLimitRequests null)', async () => {
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());
    expect(deps.rateLimiterCheck).not.toHaveBeenCalled();
  });

  it('blocks with RATE_LIMITED when the configured rate limit is exceeded', async () => {
    deps.rateLimiterCheck.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const policy = basePolicy({ rateLimitRequests: 10, rateLimitWindowSeconds: 3600 });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy), 'RATE_LIMITED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed with POLICY_UNAVAILABLE when the rate limiter itself throws', async () => {
    deps.rateLimiterCheck.mockRejectedValue(new Error('rpc missing'));
    const policy = basePolicy({ rateLimitRequests: 10, rateLimitWindowSeconds: 3600 });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy), 'POLICY_UNAVAILABLE');
  });

  it('never rate-limits a system actor with no userId', async () => {
    const policy = basePolicy({ rateLimitRequests: 1, rateLimitWindowSeconds: 60 });
    const ctx = baseContext({ userId: undefined, actorType: 'system' });
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ userId: null, actorType: 'system', source: 'system_actor' }));
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
    expect(deps.rateLimiterCheck).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // ── 4. Dedupe ────────────────────────────────────────────────────────────

  it('skips dedupe entirely when no idempotencyKey is provided', async () => {
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());
    expect(deps.dedupeBegin).not.toHaveBeenCalled();
  });

  it('blocks with DUPLICATE_IN_PROGRESS when a lock is already in_progress', async () => {
    deps.dedupeBegin.mockResolvedValue({ lockId: 'lock-1', outcome: 'in_progress', resultRef: null });
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy()), 'DUPLICATE_IN_PROGRESS');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blocks with DUPLICATE_IN_PROGRESS when a lock is already completed (no stored response to replay)', async () => {
    deps.dedupeBegin.mockResolvedValue({ lockId: 'lock-1', outcome: 'completed', resultRef: 'event-99' });
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy()), 'DUPLICATE_IN_PROGRESS');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('proceeds and completes the lock on success when the dedupe outcome is started', async () => {
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deps.dedupeComplete).toHaveBeenCalledWith('lock-1', 'event-1');
  });

  it('proceeds when the dedupe outcome is reclaimed (expired lease)', async () => {
    deps.dedupeBegin.mockResolvedValue({ lockId: 'lock-2', outcome: 'reclaimed', resultRef: null });
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expect(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy())).resolves.toBe('ok');
  });

  it('fails closed with POLICY_UNAVAILABLE when the dedupe store itself throws', async () => {
    deps.dedupeBegin.mockRejectedValue(new Error('rpc missing'));
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy()), 'POLICY_UNAVAILABLE');
  });

  it('marks the dedupe lock failed when the provider call itself fails', async () => {
    invoke.mockRejectedValue(new Error('provider down'));
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expect(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy())).rejects.toThrow('provider down');
    expect(deps.dedupeFail).toHaveBeenCalledWith('lock-1');
  });

  // ── 5/6. Atomic quota + budget + reserve ──────────────────────────────────

  it('reserves provider_requests=1 by default when no estimatedMetrics is supplied, with no budget scopes when none configured', async () => {
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.estimatedMetrics).toEqual([{ metricKey: 'provider_requests', quantity: 1 }]);
    expect(params.budgetScopes).toEqual([]);
  });

  it('respects maxPhysicalAttempts for the default reservation quantity', async () => {
    const ctx = baseContext({ maxPhysicalAttempts: 3 });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.estimatedMetrics).toEqual([{ metricKey: 'provider_requests', quantity: 3 }]);
  });

  it('a metric with no matching entitlement limit is reserved without a quota bucket (limitQuantity/period fields absent)', async () => {
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'tts_characters', quantity: 42 }] });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.estimatedMetrics).toEqual([{ metricKey: 'tts_characters', quantity: 42 }]);
  });

  it('a metric with a resolved accumulated-period limit carries limitQuantity/periodType/periodStart/periodEnd into the reservation', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({
      limits: [{ metricKey: 'session_seconds', limit: 600, period: 'month', periodStart: '2026-07-01T00:00:00.000Z', resetAt: '2026-08-01T00:00:00.000Z' }],
    }));
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 40 }] });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.estimatedMetrics).toEqual([{
      metricKey: 'session_seconds', quantity: 40, limitQuantity: 600, periodType: 'month',
      periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-08-01T00:00:00.000Z',
    }]);
  });

  it('a null (unlimited) entitlement limit is never sent as a quota-bucket constraint', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({
      limits: [{ metricKey: 'session_seconds', limit: null, period: 'month', periodStart: '2026-07-01T00:00:00.000Z', resetAt: '2026-08-01T00:00:00.000Z' }],
    }));
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 999999 }] });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.estimatedMetrics).toEqual([{ metricKey: 'session_seconds', quantity: 999999 }]);
  });

  it('builds day and month budget scopes at feature scope from policy.dailyBudgetUsd/monthlyBudgetUsd when no scope type is reported (default/back-compat)', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '5.00', monthlyBudgetUsd: '100.00' });
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.budgetScopes).toHaveLength(2);
    expect(params.budgetScopes.map((s) => s.periodType).sort()).toEqual(['day', 'month']);
    expect(params.budgetScopes.every((s) => s.scopeType === 'feature' && s.scopeKey === 'writing.correct')).toBe(true);
  });

  // ── Global/provider budget scope must be ONE shared bucket, not N per-feature buckets ──
  // Regression coverage: buildBudgetScopes used to hardcode scopeType:
  // 'feature' regardless of which ai_runtime_controls row actually produced
  // the winning dailyBudgetUsd/monthlyBudgetUsd value — a budget an
  // administrator configured only at 'global' would silently become an
  // independent per-feature bucket for every feature that inherited it,
  // each individually allowed up to the full configured amount instead of
  // sharing one real cap.

  it('a budget resolved from the global scope reserves against scopeType=global, scopeKey=global — the SAME bucket for two different feature keys', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '10.00', dailyBudgetScopeType: 'global' });
    await executeEnforcedPipeline('writing.correct', baseContext({ featureKey: 'writing.correct' }), invoke, deps, policy);
    const paramsA = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(paramsA.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'global', scopeKey: 'global', limitUsd: '10.00' })]);

    deps.reserve.mockClear();
    await executeEnforcedPipeline('listening.episode_generate_story', baseContext({ featureKey: 'listening.episode_generate_story' }), invoke, deps, policy);
    const paramsB = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(paramsB.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'global', scopeKey: 'global', limitUsd: '10.00' })]);

    // Identical scope on both calls — a real reserve_gateway_usage_v1 would
    // touch/lock the exact same ai_gateway_budget_buckets row for both,
    // proving they share one cap rather than each getting their own.
    expect(paramsA.budgetScopes).toEqual(paramsB.budgetScopes);
  });

  it('a budget resolved from the provider scope reserves against scopeType=provider, scopeKey=<provider>', async () => {
    const policy = basePolicy({ monthlyBudgetUsd: '50.00', monthlyBudgetScopeType: 'provider' });
    const ctx = baseContext({ provider: 'openai' });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'provider', scopeKey: 'openai', limitUsd: '50.00' })]);
  });

  it('a budget resolved from the user scope reserves against scopeType=user, scopeKey=<userId>', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '2.00', dailyBudgetScopeType: 'user' });
    const ctx = baseContext({ userId: 'user-456' });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'user', scopeKey: 'user-456' })]);
  });

  it('a user-scoped budget for a system actor (no userId) falls back to feature scope rather than inventing a shared bucket', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '2.00', dailyBudgetScopeType: 'user' });
    const ctx = baseContext({ userId: undefined, actorType: 'system' });
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ userId: null, actorType: 'system', source: 'system_actor' }));
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'feature', scopeKey: 'writing.correct' })]);
  });

  it('Conversation (conversation.create_session) and Pronunciation (pronunciation.start_assessment) correctly enter the SAME global budget bucket when a global budget is configured', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '20.00', dailyBudgetScopeType: 'global' });

    await executeEnforcedPipeline('conversation.create_session', baseContext({ featureKey: 'conversation.create_session' }), invoke, deps, policy);
    const conversationParams = deps.reserve.mock.calls[0][0] as ReserveUsageParams;

    deps.reserve.mockClear();
    await executeEnforcedPipeline('pronunciation.start_assessment', baseContext({ featureKey: 'pronunciation.start_assessment', provider: 'azure' }), invoke, deps, policy);
    const pronunciationParams = deps.reserve.mock.calls[0][0] as ReserveUsageParams;

    // Both reserve against the identical (scope_type, scope_key, period)
    // triple — a real reserve_gateway_usage_v1 locks/increments the exact
    // same ai_gateway_budget_buckets row for either call, so spend from one
    // feature genuinely counts against the other's remaining budget.
    expect(conversationParams.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'global', scopeKey: 'global', limitUsd: '20.00' })]);
    expect(pronunciationParams.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'global', scopeKey: 'global', limitUsd: '20.00' })]);
    expect(conversationParams.budgetScopes).toEqual(pronunciationParams.budgetScopes);
  });

  it('day and month budgets resolved from DIFFERENT scopes (e.g. daily=global, monthly=feature) each get their own correct scope independently', async () => {
    const policy = basePolicy({
      dailyBudgetUsd: '10.00', dailyBudgetScopeType: 'global',
      monthlyBudgetUsd: '200.00', monthlyBudgetScopeType: 'feature',
    });
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    const daily = params.budgetScopes.find((s) => s.periodType === 'day');
    const monthly = params.budgetScopes.find((s) => s.periodType === 'month');
    expect(daily).toEqual(expect.objectContaining({ scopeType: 'global', scopeKey: 'global' }));
    expect(monthly).toEqual(expect.objectContaining({ scopeType: 'feature', scopeKey: 'writing.correct' }));
  });

  it('blocks with QUOTA_EXCEEDED when reserve() reports a blocked quota (atomic check failed server-side)', async () => {
    deps.reserve.mockResolvedValue({ reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'QUOTA_EXCEEDED', blockedDetail: 'session_seconds' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy()), 'QUOTA_EXCEEDED');
    expect(invoke).not.toHaveBeenCalled();
    expect(deps.startEvent).not.toHaveBeenCalled();
  });

  it('blocks with BUDGET_EXCEEDED when reserve() reports a blocked budget (atomic check failed server-side)', async () => {
    deps.reserve.mockResolvedValue({ reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'BUDGET_EXCEEDED', blockedDetail: 'feature:writing.correct' });
    const policy = basePolicy({ dailyBudgetUsd: '1.00' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy), 'BUDGET_EXCEEDED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails the dedupe lock too when a blocked reservation is reported', async () => {
    deps.reserve.mockResolvedValue({ reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'QUOTA_EXCEEDED', blockedDetail: 'x' });
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expect(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy())).rejects.toThrow();
    expect(deps.dedupeFail).toHaveBeenCalledWith('lock-1');
  });

  it('blocks with RESERVATION_FAILED when reserve() itself throws, and fails the dedupe lock too', async () => {
    deps.reserve.mockRejectedValue(new Error('reservation rpc failed'));
    const ctx = baseContext({ idempotencyKey: 'idem-1' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy()), 'RESERVATION_FAILED');
    expect(invoke).not.toHaveBeenCalled();
    expect(deps.dedupeFail).toHaveBeenCalledWith('lock-1');
  });

  it('proceeds without reserving when no reservationsRepository is configured (legacy-safe, no crash)', async () => {
    delete (deps as any).reservationsRepository;
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).resolves.toBe('ok');
  });

  // ── Centralized conservative cost estimate (budget-enforcement fix) ─────
  // Proves estimatedCostUsd sent to reserve() is now a real, centrally
  // computed figure — never the always-null context.estimatedCostUsd no
  // real caller populates — so a single call whose own worst-case cost
  // already exceeds the remaining budget can be blocked by THIS call's own
  // reservation, not just by an unrelated later one.

  describe('centralized conservative cost estimate wired into reserve()', () => {
    it('skips pricing lookups entirely (estimatedCostUsd stays null) when no budget scope is configured', async () => {
      const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'output_text_tokens', quantity: 1000 }] });
      await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy()); // no dailyBudgetUsd/monthlyBudgetUsd
      expect(deps.pricingRepository.findActivePrice).not.toHaveBeenCalled();
      const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
      expect(params.estimatedCostUsd).toBeNull();
    });

    it('computes a real conservative estimate from estimatedMetrics × provider_pricing once a budget scope exists', async () => {
      (deps.pricingRepository.findActivePrice as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'price-1', pricePerUnit: '0.60', unitSize: '1000000', currency: 'USD',
      });
      const policy = basePolicy({ dailyBudgetUsd: '5.00' });
      const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'output_text_tokens', quantity: 1_000_000 }] });
      await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
      const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
      expect(params.estimatedCostUsd).toBe('0.6');
    });

    it('never trusts context.estimatedCostUsd for the reservation — a per-feature guess cannot bypass the centralized estimate', async () => {
      (deps.pricingRepository.findActivePrice as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'price-1', pricePerUnit: '0.60', unitSize: '1000000', currency: 'USD',
      });
      const policy = basePolicy({ dailyBudgetUsd: '5.00' });
      // A caller claiming a suspiciously cheap $0.0001 for a 1M-token call —
      // the centralized estimate must override it with the real ~$0.60.
      const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'output_text_tokens', quantity: 1_000_000 }], estimatedCostUsd: '0.0001' });
      await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
      const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
      expect(params.estimatedCostUsd).toBe('0.6');
    });

    it('an unpriced billable metric against a configured budget scope sends a NULL estimate — fails closed at the SQL layer, never treated as $0 in the TS layer', async () => {
      // findActivePrice keeps makeDeps()'s default (resolves null) — no price registered yet.
      const policy = basePolicy({ dailyBudgetUsd: '5.00' });
      const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'output_text_tokens', quantity: 1_000_000 }] });
      await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy);
      const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
      expect(params.estimatedCostUsd).toBeNull();
    });

    it('a pricing-lookup failure fails closed to a NULL estimate rather than throwing or defaulting to $0', async () => {
      (deps.pricingRepository.findActivePrice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pricing db down'));
      const policy = basePolicy({ dailyBudgetUsd: '5.00' });
      const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'output_text_tokens', quantity: 1_000_000 }] });
      await expect(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, policy)).resolves.toBe('ok');
      const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
      expect(params.estimatedCostUsd).toBeNull();
    });

    it('provider_requests-only calls (the generic pipeline fallback) estimate a real $0 — no price lookup needed, never unresolved', async () => {
      const policy = basePolicy({ dailyBudgetUsd: '5.00' });
      await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy); // default estimatedMetrics: provider_requests=1
      expect(deps.pricingRepository.findActivePrice).not.toHaveBeenCalled();
      const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
      expect(params.estimatedCostUsd).toBe('0');
    });
  });

  // ── Acceptance scenario (Etapa 11 correction, §1): 600 session_seconds/month ──
  // Proves the TS layer wires the exact request a real reserve_gateway_usage_v1
  // would need to enforce this correctly — the atomicity itself is a SQL-level
  // guarantee (row locks), not something a mock can prove; see the manual SQL
  // validation file's scenario 1/3 analogues.

  it('acceptance: a stateful mock proves 40+40 concurrent-style calls against a 50-remaining bucket allow only one', async () => {
    let committed = 300;
    let reserved = 250; // matches the scenario: 600 limit, 300 committed, 250 reserved => 50 remaining
    deps.reserve.mockImplementation(async (params: ReserveUsageParams): Promise<ReservationResult> => {
      const est = params.estimatedMetrics.find((m) => m.metricKey === 'session_seconds')!;
      const available = (est.limitQuantity ?? Infinity) - committed - reserved;
      if (est.quantity > available) {
        return { reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'QUOTA_EXCEEDED', blockedDetail: 'session_seconds' };
      }
      reserved += est.quantity;
      return { reservationId: `res-${reserved}`, status: 'pending', expiresAt: new Date(2000).toISOString() };
    });
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({
      limits: [{ metricKey: 'session_seconds', limit: 600, period: 'month', periodStart: '2026-07-01T00:00:00.000Z', resetAt: '2026-08-01T00:00:00.000Z' }],
    }));

    const ctx1 = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 40 }], idempotencyKey: 'attempt-1' });
    const ctx2 = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 40 }], idempotencyKey: 'attempt-2' });

    const [r1, r2] = await Promise.allSettled([
      executeEnforcedPipeline('writing.correct', ctx1, invoke, deps, basePolicy()),
      executeEnforcedPipeline('writing.correct', ctx2, invoke, deps, basePolicy()),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(GatewayError);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('QUOTA_EXCEEDED');
  });

  // ── 7-13. Invoke, measure, cost, commit/release, rollup, breaker ────────

  it('happy path: invokes once, records the event, commits the reservation with real actual metrics, closes the breaker', async () => {
    const extractMetrics = vi.fn().mockReturnValue([
      { metricKey: 'output_text_tokens', unitType: 'token', quantity: 10, isBillable: true, measurementSource: 'provider_response' },
    ]);
    const result = await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy(), extractMetrics);

    expect(result).toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deps.startEvent).toHaveBeenCalledTimes(1);
    expect(deps.completeEvent).toHaveBeenCalledTimes(1);
    expect(deps.insertMetrics).toHaveBeenCalledWith('event-1', expect.any(Array));
    expect(deps.commit).toHaveBeenCalledWith('res-1', 'event-1', null, [{ metricKey: 'output_text_tokens', quantity: 10 }]);
    expect(deps.recordOutcome).toHaveBeenCalledWith('openai', null, 'writing.correct', true);
  });

  // Budget-enforcement correction: no real caller ever populates
  // context.estimatedCostUsd (confirmed by reading every call site), so
  // committing it verbatim left every budget bucket's committed_cost_usd
  // frozen at $0 forever regardless of real spend. The fix commits the REAL
  // cost reconcileEventCost just calculated instead.
  it('commits the REAL reconciled cost to the budget bucket, never the (always-absent) pre-call estimate', async () => {
    const usageRepo = deps.usageRepository as unknown as {
      getEventForCosting: ReturnType<typeof vi.fn>;
      getMetricsForEvent: ReturnType<typeof vi.fn>;
    };
    usageRepo.getEventForCosting.mockResolvedValue({
      id: 'event-1', provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini',
      startedAt: new Date(0).toISOString(), costStatus: 'pending',
    });
    usageRepo.getMetricsForEvent.mockResolvedValue([
      { id: 'metric-1', metricKey: 'output_text_tokens', quantity: 10, isBillable: true },
    ]);
    deps.pricingRepository.findActivePrice = vi.fn().mockResolvedValue({
      id: 'price-1', pricePerUnit: '0.60', unitSize: '1000000',
    });
    const expectedCost = calculateLineCostUsd(10, '0.60', '1000000');

    const extractMetrics = vi.fn().mockReturnValue([
      { metricKey: 'output_text_tokens', unitType: 'token', quantity: 10, isBillable: true, measurementSource: 'provider_response' },
    ]);
    // context.estimatedCostUsd deliberately left unset — matching every real caller today.
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy(), extractMetrics);

    expect(deps.commit).toHaveBeenCalledWith('res-1', 'event-1', expectedCost, [{ metricKey: 'output_text_tokens', quantity: 10 }]);
  });

  it('falls back to the pre-call estimate for commit only while pricing has not resolved yet (cost still pending)', async () => {
    // getEventForCosting/getMetricsForEvent keep their makeDeps() defaults
    // (null / []), so reconcileEventCost resolves to 'not_found'/'partial'
    // (totalCostUsd stays null) — same as production until pricing exists.
    const ctx = baseContext({ estimatedCostUsd: '0.02' });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    expect(deps.commit).toHaveBeenCalledWith('res-1', 'event-1', '0.02', []);
  });

  // ── Real cost vs. reserved estimate: both directions ─────────────────────
  // The comparison itself (release the excess back to available, or commit
  // an overage in full without capping) is a SQL-level guarantee inside
  // commit_gateway_reservation_v1 (reserved_cost_usd -= the ORIGINAL
  // reserved amount, unconditionally; committed_cost_usd += whatever the
  // real cost turns out to be) — unchanged by this delivery. These prove
  // the TS layer always hands that function the REAL calculated cost,
  // regardless of which direction it differs from the pre-call estimate.

  it('real cost LESS than the reserved estimate is still committed as the exact real amount — commit_gateway_reservation_v1 frees the unused difference back to available budget', async () => {
    const usageRepo = deps.usageRepository as unknown as { getEventForCosting: ReturnType<typeof vi.fn>; getMetricsForEvent: ReturnType<typeof vi.fn> };
    usageRepo.getEventForCosting.mockResolvedValue({
      id: 'event-1', provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini',
      startedAt: new Date(0).toISOString(), costStatus: 'pending',
    });
    // Real usage (10 tokens) turns out far smaller than what a caller might
    // have conservatively estimated (e.g. a 1000-token ceiling reserved
    // upfront) — the reservation sizing itself is irrelevant to commit();
    // only the real metrics/price matter for what gets committed.
    usageRepo.getMetricsForEvent.mockResolvedValue([{ id: 'metric-1', metricKey: 'output_text_tokens', quantity: 10, isBillable: true }]);
    deps.pricingRepository.findActivePrice = vi.fn().mockResolvedValue({ id: 'price-1', pricePerUnit: '0.60', unitSize: '1000000' });
    const realCost = calculateLineCostUsd(10, '0.60', '1000000'); // tiny — much less than a conservative reservation would have held

    const extractMetrics = vi.fn().mockReturnValue([{ metricKey: 'output_text_tokens', unitType: 'token', quantity: 10, isBillable: true, measurementSource: 'provider_response' }]);
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy(), extractMetrics);

    expect(deps.commit).toHaveBeenCalledWith('res-1', 'event-1', realCost, [{ metricKey: 'output_text_tokens', quantity: 10 }]);
  });

  it('real cost GREATER than the reserved estimate (overage) is still fully committed — never capped/truncated at the original reservation', async () => {
    const usageRepo = deps.usageRepository as unknown as { getEventForCosting: ReturnType<typeof vi.fn>; getMetricsForEvent: ReturnType<typeof vi.fn> };
    usageRepo.getEventForCosting.mockResolvedValue({
      id: 'event-1', provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini',
      startedAt: new Date(0).toISOString(), costStatus: 'pending',
    });
    // Real usage (5,000,000 tokens) far exceeds any small ceiling a caller
    // might have reserved upfront — the overage must still be recorded in
    // full, never silently dropped or clamped.
    usageRepo.getMetricsForEvent.mockResolvedValue([{ id: 'metric-1', metricKey: 'output_text_tokens', quantity: 5_000_000, isBillable: true }]);
    deps.pricingRepository.findActivePrice = vi.fn().mockResolvedValue({ id: 'price-1', pricePerUnit: '0.60', unitSize: '1000000' });
    const realCost = calculateLineCostUsd(5_000_000, '0.60', '1000000');

    const extractMetrics = vi.fn().mockReturnValue([{ metricKey: 'output_text_tokens', unitType: 'token', quantity: 5_000_000, isBillable: true, measurementSource: 'provider_response' }]);
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy(), extractMetrics);

    expect(deps.commit).toHaveBeenCalledWith('res-1', 'event-1', realCost, [{ metricKey: 'output_text_tokens', quantity: 5_000_000 }]);
    // The real amount is committed verbatim — no min()/cap logic anywhere
    // in the TS layer that could silently truncate an overage.
    expect(Number(realCost)).toBeGreaterThan(1); // sanity: this really is a large, non-trivial overage
  });

  it('provider failure releases the reservation and records a breaker failure, never a usage event completion', async () => {
    invoke.mockRejectedValue(new Error('provider down'));
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).rejects.toThrow('provider down');

    expect(deps.release).toHaveBeenCalledWith('res-1', 'provider_error');
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.completeEvent).not.toHaveBeenCalled();
    expect(deps.failEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordOutcome).toHaveBeenCalledWith('openai', null, 'writing.correct', false);
  });

  it('marks reconciliation_required (never blindly releases) when the reservation commit itself fails after a successful call', async () => {
    deps.commit.mockRejectedValue(new Error('commit rpc failed'));
    const result = await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());

    expect(result).toBe('ok'); // the student's response is never discarded for a post-call telemetry failure
    expect(deps.markReconciliationRequired).toHaveBeenCalledWith('res-1', 'commit_failed_after_success');
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('a startEvent telemetry failure never blocks the response — invoke still runs and its result is still returned', async () => {
    deps.startEvent.mockRejectedValue(new Error('db down'));
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).resolves.toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a rollup failure never blocks the response', async () => {
    (deps.dailyRollupRepository.rebuildBucketForEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rollup down'));
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).resolves.toBe('ok');
  });

  it('never creates a usage event for any blocked decision (entitlement/breaker/rate-limit/dedupe/reservation)', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ allowed: false }));
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).rejects.toThrow();
    expect(deps.startEvent).not.toHaveBeenCalled();
  });

  it('records an "allowed" decision right before invoking, and a "blocked" decision when denied', async () => {
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());
    expect(deps.decisionsRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'allowed', reasonCode: 'OK' }));

    deps.decisionsRecord.mockClear();
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ allowed: false }));
    await expect(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy())).rejects.toThrow();
    expect(deps.decisionsRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', reasonCode: 'USER_BLOCKED' }));
  });

  // ── System actor budgets (correction §item 18) ───────────────────────────

  it('a system actor (no userId) still has its estimate checked against configured feature/provider/global budgets', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '10.00' });
    const ctx = baseContext({ userId: undefined, actorType: 'system' });
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({ userId: null, actorType: 'system', source: 'system_actor' }));
    await executeEnforcedPipeline('listening.episode_generate_story', ctx, invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.budgetScopes).toHaveLength(1);
    expect(params.budgetScopes[0]).toEqual(expect.objectContaining({ scopeType: 'feature', limitUsd: '10.00' }));
  });
});
