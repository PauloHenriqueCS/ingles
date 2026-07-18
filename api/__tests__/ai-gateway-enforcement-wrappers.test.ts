/**
 * Unit tests for the thin RPC-wrapper modules of Etapa 11's enforcement
 * layer: budgets.ts, rate-limiter.ts, dedupe.ts, reservations.ts,
 * circuit-breaker.ts. Each wraps a single Postgres RPC (or, for budgets.ts,
 * two direct table reads) — these tests verify the exact params sent, the
 * response mapped back, and that RPC/query failures propagate as real
 * errors (never silently swallowed — the caller, enforcement.ts, is what
 * decides fail-open vs fail-closed).
 */

import { describe, it, expect, vi } from 'vitest';
import { SupabaseBudgetChecker } from '../_ai-gateway/budgets';
import { SupabaseRateLimiter } from '../_ai-gateway/rate-limiter';
import { SupabaseDedupeStore, computeIdempotencyFingerprint } from '../_ai-gateway/dedupe';
import { SupabaseReservationsRepository } from '../_ai-gateway/reservations';
import { SupabaseCircuitBreaker } from '../_ai-gateway/circuit-breaker';

// ── budgets.ts ────────────────────────────────────────────────────────────

function makeBudgetSupabaseMock(usageRows: Array<Record<string, unknown>>, reservationRows: Array<Record<string, unknown>> = []) {
  const from = vi.fn((table: string) => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'lt', 'not']) chain[m] = vi.fn().mockReturnValue(chain);
    // usage_daily query resolves when awaited directly (no terminal method call);
    // reservations query is the second .from() call in check().
    chain.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
      resolve({ data: table === 'usage_daily' ? usageRows : reservationRows, error: null });
    return chain;
  });
  return { from } as any;
}

describe('SupabaseBudgetChecker', () => {
  it('returns withinBudget=true with no query at all when limitUsd is null (unlimited)', async () => {
    const supabase = makeBudgetSupabaseMock([]);
    const checker = new SupabaseBudgetChecker(supabase);
    const result = await checker.check({ scope: 'feature', scopeKey: 'writing.correct', period: 'day', limitUsd: null, additionalEstimatedCostUsd: null }, new Date());
    expect(result).toEqual({ withinBudget: true, limitUsd: null, spentUsd: '0', remainingUsd: null });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('sums calculated_cost_usd across usage_daily rows plus pending reservations plus the additional estimate', async () => {
    const supabase = makeBudgetSupabaseMock(
      [{ calculated_cost_usd: '1.50' }, { calculated_cost_usd: '0.25' }],
      [{ estimated_cost_usd: '0.10' }],
    );
    const checker = new SupabaseBudgetChecker(supabase);
    const result = await checker.check({ scope: 'feature', scopeKey: 'writing.correct', period: 'day', limitUsd: '2.00', additionalEstimatedCostUsd: '0.05' }, new Date());

    // 1.50 + 0.25 + 0.10 + 0.05 = 1.90 <= 2.00 (rationalToDecimalString normalizes trailing zeros)
    expect(result.withinBudget).toBe(true);
    expect(result.spentUsd).toBe('1.9');
    expect(result.remainingUsd).toBe('0.1');
  });

  it('is exact at the boundary — spent exactly equal to the limit is still within budget', async () => {
    const supabase = makeBudgetSupabaseMock([{ calculated_cost_usd: '1.00' }]);
    const checker = new SupabaseBudgetChecker(supabase);
    const result = await checker.check({ scope: 'global', scopeKey: 'global', period: 'day', limitUsd: '1.00', additionalEstimatedCostUsd: null }, new Date());
    expect(result.withinBudget).toBe(true);
    expect(result.remainingUsd).toBe('0');
  });

  it('treats a NULL calculated_cost_usd row as unknown, not zero — never contributes to the sum but never crashes either', async () => {
    const supabase = makeBudgetSupabaseMock([{ calculated_cost_usd: null }, { calculated_cost_usd: '0.50' }]);
    const checker = new SupabaseBudgetChecker(supabase);
    const result = await checker.check({ scope: 'feature', scopeKey: 'x', period: 'day', limitUsd: '10', additionalEstimatedCostUsd: null }, new Date());
    expect(result.spentUsd).toBe('0.5');
  });

  it('reports withinBudget=false once spend exceeds the limit', async () => {
    const supabase = makeBudgetSupabaseMock([{ calculated_cost_usd: '5.00' }]);
    const checker = new SupabaseBudgetChecker(supabase);
    const result = await checker.check({ scope: 'user', scopeKey: 'u1', period: 'month', limitUsd: '4.99', additionalEstimatedCostUsd: null }, new Date());
    expect(result.withinBudget).toBe(false);
    expect(result.remainingUsd).toBe('0');
  });
});

// ── rate-limiter.ts ───────────────────────────────────────────────────────

describe('SupabaseRateLimiter', () => {
  it('calls check_and_increment_rate_limit with a namespaced gateway: route key', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: true }, error: null });
    const limiter = new SupabaseRateLimiter({ rpc } as any);

    const result = await limiter.check('user-1', 'writing.correct', 3600, 100);

    expect(rpc).toHaveBeenCalledWith('check_and_increment_rate_limit', {
      p_user_id: 'user-1', p_route_key: 'gateway:writing.correct', p_window_seconds: 3600, p_max_requests: 100,
    });
    expect(result).toEqual({ allowed: true, retryAfterSeconds: undefined });
  });

  it('maps allowed=false with retry_after', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: false, retry_after: 42 }, error: null });
    const limiter = new SupabaseRateLimiter({ rpc } as any);
    const result = await limiter.check('user-1', 'writing.correct', 60, 5);
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it('throws when the RPC errors — the caller decides fail-open vs fail-closed', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    const limiter = new SupabaseRateLimiter({ rpc } as any);
    await expect(limiter.check('user-1', 'writing.correct', 60, 5)).rejects.toThrow('check_and_increment_rate_limit failed');
  });
});

// ── dedupe.ts ─────────────────────────────────────────────────────────────

describe('computeIdempotencyFingerprint', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeIdempotencyFingerprint('secret', ['user-1', 'writing.correct', 'entry-1']);
    const b = computeIdempotencyFingerprint('secret', ['user-1', 'writing.correct', 'entry-1']);
    expect(a).toBe(b);
  });

  it('changes when any part changes', () => {
    const a = computeIdempotencyFingerprint('secret', ['user-1', 'writing.correct', 'entry-1']);
    const b = computeIdempotencyFingerprint('secret', ['user-1', 'writing.correct', 'entry-2']);
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes — cannot be forged without the server-only secret', () => {
    const a = computeIdempotencyFingerprint('secret-a', ['user-1', 'writing.correct']);
    const b = computeIdempotencyFingerprint('secret-b', ['user-1', 'writing.correct']);
    expect(a).not.toBe(b);
  });

  it('is a 64-char lowercase hex string (SHA-256)', () => {
    const fp = computeIdempotencyFingerprint('secret', ['x']);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SupabaseDedupeStore', () => {
  it('begin() maps the RPC row to camelCase', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ lock_id: 'lock-1', outcome: 'started', result_ref: null }], error: null });
    const store = new SupabaseDedupeStore({ rpc } as any);
    const result = await store.begin('writing.correct', 'idem-1', 120);
    expect(rpc).toHaveBeenCalledWith('begin_gateway_idempotent_op_v1', { p_scope: 'writing.correct', p_idempotency_key: 'idem-1', p_lease_seconds: 120 });
    expect(result).toEqual({ lockId: 'lock-1', outcome: 'started', resultRef: null });
  });

  it('complete() and fail() call their respective RPCs with the lock id', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const store = new SupabaseDedupeStore({ rpc } as any);
    await store.complete('lock-1', 'event-1');
    expect(rpc).toHaveBeenCalledWith('complete_gateway_idempotent_op_v1', { p_lock_id: 'lock-1', p_result_ref: 'event-1' });
    await store.fail('lock-1');
    expect(rpc).toHaveBeenCalledWith('fail_gateway_idempotent_op_v1', { p_lock_id: 'lock-1' });
  });

  it('throws on RPC error rather than silently succeeding', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const store = new SupabaseDedupeStore({ rpc } as any);
    await expect(store.begin('scope', 'key', 60)).rejects.toThrow('begin_gateway_idempotent_op_v1 failed: boom');
  });
});

// ── reservations.ts ───────────────────────────────────────────────────────

describe('SupabaseReservationsRepository', () => {
  it('reserve() maps params and the returned row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ reservation_id: 'res-1', status: 'pending', expires_at: '2026-01-01T00:00:00Z' }], error: null });
    const repo = new SupabaseReservationsRepository({ rpc } as any);

    const result = await repo.reserve({
      idempotencyKey: 'idem-1', userId: 'u1', initiatedByUserId: 'u1', featureKey: 'writing.correct',
      provider: 'openai', model: 'gpt-4o-mini', estimatedMetrics: [{ metricKey: 'output_text_tokens', quantity: 500 }],
      budgetScopes: [{ scopeType: 'feature', scopeKey: 'writing.correct', periodType: 'day', periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-01-02T00:00:00Z', limitUsd: '5.00' }],
      estimatedCostUsd: '0.01', expiresInSeconds: 120,
    });

    expect(rpc).toHaveBeenCalledWith('reserve_gateway_usage_v1', expect.objectContaining({
      p_idempotency_key: 'idem-1', p_feature_key: 'writing.correct', p_provider: 'openai', p_model: 'gpt-4o-mini',
      p_metrics: [{ quota_key: 'output_text_tokens', unit_type: 'unit', reserved_quantity: 500, limit_quantity: null, period_type: null, period_start: null, period_end: null }],
      p_budget_scopes: [{ scope_type: 'feature', scope_key: 'writing.correct', period_type: 'day', period_start: '2026-01-01T00:00:00Z', period_end: '2026-01-02T00:00:00Z', limit_usd: '5.00' }],
      p_estimated_cost_usd: '0.01', p_expires_in_seconds: 120,
    }));
    expect(result).toEqual({ reservationId: 'res-1', status: 'pending', expiresAt: '2026-01-01T00:00:00Z', blockedReason: null, blockedDetail: null });
  });

  it('commit/release/markReconciliationRequired call their respective RPCs', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const repo = new SupabaseReservationsRepository({ rpc } as any);

    await repo.commit('res-1', 'event-1', '0.02');
    expect(rpc).toHaveBeenCalledWith('commit_gateway_reservation_v1', { p_reservation_id: 'res-1', p_usage_event_id: 'event-1', p_actual_cost_usd: '0.02', p_actual_metrics: null });

    await repo.commit('res-2', 'event-2', '0.03', [{ metricKey: 'output_text_tokens', quantity: 15 }]);
    expect(rpc).toHaveBeenCalledWith('commit_gateway_reservation_v1', {
      p_reservation_id: 'res-2', p_usage_event_id: 'event-2', p_actual_cost_usd: '0.03',
      p_actual_metrics: [{ quota_key: 'output_text_tokens', actual_quantity: 15 }],
    });

    await repo.release('res-1', 'provider_error');
    expect(rpc).toHaveBeenCalledWith('release_gateway_reservation_v1', { p_reservation_id: 'res-1', p_reason: 'provider_error' });

    await repo.markReconciliationRequired('res-1', 'commit_failed_after_success');
    expect(rpc).toHaveBeenCalledWith('mark_gateway_reservation_reconciliation_required_v1', { p_reservation_id: 'res-1', p_reason: 'commit_failed_after_success' });
  });

  it('throws on RPC error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const repo = new SupabaseReservationsRepository({ rpc } as any);
    await expect(repo.commit('res-1', 'event-1', null)).rejects.toThrow('commit_gateway_reservation_v1 failed: boom');
  });
});

// ── circuit-breaker.ts ────────────────────────────────────────────────────

describe('SupabaseCircuitBreaker', () => {
  it('getState() maps the RPC row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ state: 'half_open', probe_allowed: true }], error: null });
    const breaker = new SupabaseCircuitBreaker({ rpc } as any);
    const result = await breaker.getState('openai', 'gpt-4o-mini', 'writing.correct');
    expect(rpc).toHaveBeenCalledWith('get_gateway_breaker_state_v1', { p_provider: 'openai', p_model: 'gpt-4o-mini', p_feature_key: 'writing.correct' });
    expect(result).toEqual({ state: 'half_open', probeAllowed: true });
  });

  it('recordOutcome() maps params and returns the new state', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ state: 'open' }], error: null });
    const breaker = new SupabaseCircuitBreaker({ rpc } as any);
    const result = await breaker.recordOutcome('openai', null, 'writing.correct', false);
    expect(rpc).toHaveBeenCalledWith('record_gateway_breaker_outcome_v1', { p_provider: 'openai', p_model: null, p_feature_key: 'writing.correct', p_success: false });
    expect(result).toBe('open');
  });

  it('throws on RPC error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    const breaker = new SupabaseCircuitBreaker({ rpc } as any);
    await expect(breaker.getState('openai', null, 'writing.correct')).rejects.toThrow('get_gateway_breaker_state_v1 failed: boom');
  });
});
