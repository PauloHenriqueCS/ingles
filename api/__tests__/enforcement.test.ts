/**
 * Unit tests for api/_ai-gateway/enforcement.ts — the enforce-mode pipeline
 * (Etapa 11, Fase 5/11/15). Unreachable in production this stage (no
 * feature's gateway_mode is 'enforce'), but must be correct and tested
 * regardless — "não fingir proteção forte" cuts both ways: the code must be
 * real, not just the refusal to activate it.
 *
 * Mocks every repository/RPC-wrapper interface directly (no real Postgres —
 * see supabase/manual-validation/ai-gateway-enforcement-concurrency.sql for
 * the concurrency-dependent scenarios that genuinely require a live
 * database and are validated there instead, honestly declared per Fase 15).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeEnforcedPipeline } from '../_ai-gateway/enforcement';
import { GatewayError } from '../_ai-gateway/errors';
import type { GatewayDeps } from '../_ai-gateway/gateway';
import type { GatewayCallContext, GatewayPolicy, EffectiveEntitlement } from '../_ai-gateway/types';

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
  rateLimiterCheck: ReturnType<typeof vi.fn>;
  dedupeBegin: ReturnType<typeof vi.fn>;
  dedupeComplete: ReturnType<typeof vi.fn>;
  dedupeFail: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  markReconciliationRequired: ReturnType<typeof vi.fn>;
  budgetCheck: ReturnType<typeof vi.fn>;
  recordOutcome: ReturnType<typeof vi.fn>;
  decisionsRecord: ReturnType<typeof vi.fn>;
} {
  const startEvent = vi.fn().mockResolvedValue('event-1');
  const completeEvent = vi.fn().mockResolvedValue(undefined);
  const failEvent = vi.fn().mockResolvedValue(undefined);
  const insertMetrics = vi.fn().mockResolvedValue(undefined);
  const entitlementResolve = vi.fn().mockResolvedValue(allowedEntitlement());
  const rateLimiterCheck = vi.fn().mockResolvedValue({ allowed: true });
  const dedupeBegin = vi.fn().mockResolvedValue({ lockId: 'lock-1', outcome: 'started', resultRef: null });
  const dedupeComplete = vi.fn().mockResolvedValue(undefined);
  const dedupeFail = vi.fn().mockResolvedValue(undefined);
  const reserve = vi.fn().mockResolvedValue({ reservationId: 'res-1', status: 'pending', expiresAt: new Date(1000).toISOString() });
  const commit = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  const markReconciliationRequired = vi.fn().mockResolvedValue(undefined);
  const budgetCheck = vi.fn().mockResolvedValue({ withinBudget: true, limitUsd: null, spentUsd: '0', remainingUsd: null });
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
    budgetChecker: { check: budgetCheck },
    circuitBreaker: { getState: vi.fn(), recordOutcome },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
    startEvent, completeEvent, failEvent, insertMetrics,
    entitlementResolve, rateLimiterCheck, dedupeBegin, dedupeComplete, dedupeFail,
    reserve, commit, release, markReconciliationRequired, budgetCheck, recordOutcome, decisionsRecord,
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

  it('blocks with QUOTA_EXCEEDED when an estimated metric exceeds its resolved limit', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({
      limits: [{ metricKey: 'session_seconds', limit: 100, period: 'month', resetAt: null }],
    }));
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 200 }] });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy()), 'QUOTA_EXCEEDED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows when the estimated metric is within its resolved limit', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({
      limits: [{ metricKey: 'session_seconds', limit: 100, period: 'month', resetAt: null }],
    }));
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 50 }] });
    await expect(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy())).resolves.toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a null limit (unlimited) never blocks regardless of estimated quantity', async () => {
    deps.entitlementResolve.mockResolvedValue(allowedEntitlement({
      limits: [{ metricKey: 'session_seconds', limit: null, period: 'month', resetAt: null }],
    }));
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'session_seconds', quantity: 999999 }] });
    await expect(executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy())).resolves.toBe('ok');
  });

  // ── 2. Budget ────────────────────────────────────────────────────────────

  it('skips the budget check entirely when policy has no configured budget (both null)', async () => {
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());
    expect(deps.budgetCheck).not.toHaveBeenCalled();
  });

  it('blocks with BUDGET_EXCEEDED when the daily budget is exceeded', async () => {
    deps.budgetCheck.mockResolvedValue({ withinBudget: false, limitUsd: '1.00', spentUsd: '1.00', remainingUsd: '0' });
    const policy = basePolicy({ dailyBudgetUsd: '1.00' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy), 'BUDGET_EXCEEDED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('checks both day and month budgets when both are configured', async () => {
    const policy = basePolicy({ dailyBudgetUsd: '5.00', monthlyBudgetUsd: '100.00' });
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy);
    expect(deps.budgetCheck).toHaveBeenCalledTimes(2);
    expect(deps.budgetCheck.mock.calls.map((c: any[]) => c[0].period).sort()).toEqual(['day', 'month']);
  });

  it('fails closed with POLICY_UNAVAILABLE when the budget check itself throws', async () => {
    deps.budgetCheck.mockRejectedValue(new Error('db down'));
    const policy = basePolicy({ dailyBudgetUsd: '5.00' });
    await expectGatewayError(executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, policy), 'POLICY_UNAVAILABLE');
    expect(invoke).not.toHaveBeenCalled();
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

  // ── 5/6. Reservation ─────────────────────────────────────────────────────

  it('reserves provider_requests=1 by default when no estimatedMetrics is supplied', async () => {
    await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy());
    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedMetrics: [{ metricKey: 'provider_requests', quantity: 1 }] }),
    );
  });

  it('respects maxPhysicalAttempts for the default reservation quantity', async () => {
    const ctx = baseContext({ maxPhysicalAttempts: 3 });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedMetrics: [{ metricKey: 'provider_requests', quantity: 3 }] }),
    );
  });

  it('uses the real estimatedMetrics when supplied instead of the default', async () => {
    const ctx = baseContext({ estimatedMetrics: [{ metricKey: 'tts_characters', quantity: 42 }] });
    await executeEnforcedPipeline('writing.correct', ctx, invoke, deps, basePolicy());
    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedMetrics: [{ metricKey: 'tts_characters', quantity: 42 }] }),
    );
  });

  it('blocks with RESERVATION_FAILED when reservation itself throws, and fails the dedupe lock too', async () => {
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

  // ── 7-13. Invoke, measure, cost, commit/release, rollup, breaker ────────

  it('happy path: invokes once, records the event, commits the reservation, closes the breaker', async () => {
    const extractMetrics = vi.fn().mockReturnValue([
      { metricKey: 'output_text_tokens', unitType: 'token', quantity: 10, isBillable: true, measurementSource: 'provider_response' },
    ]);
    const result = await executeEnforcedPipeline('writing.correct', baseContext(), invoke, deps, basePolicy(), extractMetrics);

    expect(result).toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deps.startEvent).toHaveBeenCalledTimes(1);
    expect(deps.completeEvent).toHaveBeenCalledTimes(1);
    expect(deps.insertMetrics).toHaveBeenCalledWith('event-1', expect.any(Array));
    expect(deps.commit).toHaveBeenCalledWith('res-1', 'event-1', null);
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

  it('never creates a usage event for any blocked decision (entitlement/budget/rate-limit/dedupe/reservation)', async () => {
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
});
