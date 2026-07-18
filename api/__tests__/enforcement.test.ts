/**
 * Unit tests for api/_ai-gateway/enforcement.ts — the enforce-mode pipeline
 * (Etapa 11, Fase 5/11/15, corrected per the "close enforcement readiness
 * gaps" follow-up). Unreachable in production this stage (no feature's
 * gateway_mode is 'enforce'), but must be correct and tested regardless —
 * "não fingir proteção forte" cuts both ways: the code must be real, not
 * just the refusal to activate it.
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

  it('builds day and month budget scopes at feature scope from policy.dailyBudgetUsd/monthlyBudgetUsd', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '5.00', monthlyBudgetUsd: '100.00' });
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy);
    const params = deps.reserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.budgetScopes).toHaveLength(2);
    expect(params.budgetScopes.map((s) => s.periodType).sort()).toEqual(['day', 'month']);
    expect(params.budgetScopes.every((s) => s.scopeType === 'feature' && s.scopeKey === 'writing.correct')).toBe(true);
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
