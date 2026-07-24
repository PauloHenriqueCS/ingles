/**
 * Unit tests for api/_realtime-budget.ts — the upfront AI Gateway budget
 * reservation for conversation.realtime_usage sessions (Realtime bills per
 * token, but the physical calls happen entirely in the browser, so this is
 * the only point where "this session's own worst-case cost already
 * exceeds the remaining budget" can be checked BEFORE an OpenAI ephemeral
 * token is ever minted).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { reserveRealtimeSessionBudget } from '../_realtime-budget';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import type { ReserveUsageParams } from '../_ai-gateway/types';
import { REALTIME_MAX_SESSION_SECONDS } from '../_realtime-constants';

describe('reserveRealtimeSessionBudget', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
  });

  it('is a no-op (always allowed, no reservation) when no budget is configured anywhere for conversation.realtime_usage — matches today\'s production reality', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled' }); // no dailyBudgetUsd/monthlyBudgetUsd
    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 900);
    expect(result).toEqual({ allowed: true, reservationId: null, blockedReason: null });
    expect(gw.mockReservationsReserve).not.toHaveBeenCalled();
    expect(gw.mockFindActivePrice).not.toHaveBeenCalled();
  });

  it('is a no-op when maxAuthorizedSeconds is 0 or negative — nothing to reserve for a session that cannot run at all', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', dailyBudgetUsd: '5.00' });
    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 0);
    expect(result).toEqual({ allowed: true, reservationId: null, blockedReason: null });
    expect(gw.mockReservationsReserve).not.toHaveBeenCalled();
  });

  it('reserves worst-case input/output audio tokens (10/sec, 20/sec) for the full authorized ceiling once a budget is configured', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', dailyBudgetUsd: '5.00', dailyBudgetScopeType: 'feature' });
    gw.mockFindActivePrice.mockImplementation(async ({ metricKey }: { metricKey: string }) => {
      if (metricKey === 'input_audio_tokens') return { id: 'p-in', pricePerUnit: '10.00', unitSize: '1000000', currency: 'USD' };
      if (metricKey === 'output_audio_tokens') return { id: 'p-out', pricePerUnit: '20.00', unitSize: '1000000', currency: 'USD' };
      return null;
    });

    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 100);

    expect(result.allowed).toBe(true);
    expect(result.reservationId).toBeTruthy();
    const params = gw.mockReservationsReserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.featureKey).toBe('conversation.realtime_usage');
    expect(params.estimatedMetrics).toEqual([
      { metricKey: 'input_audio_tokens', quantity: 1000 },  // 100s × 10/sec
      { metricKey: 'output_audio_tokens', quantity: 2000 }, // 100s × 20/sec
    ]);
    // input: 1000 × 10.00 / 1,000,000 = 0.01 ; output: 2000 × 20.00 / 1,000,000 = 0.04 ; total 0.05
    expect(params.estimatedCostUsd).toBe('0.05');
    expect(params.budgetScopes).toEqual([expect.objectContaining({ scopeType: 'feature', scopeKey: 'conversation.realtime_usage', limitUsd: '5.00' })]);
    expect(params.expiresInSeconds).toBe(REALTIME_MAX_SESSION_SECONDS);
  });

  it('refuses (blocked) when the reservation itself reports BUDGET_EXCEEDED — a session whose own worst-case cost cannot be afforded never gets an OpenAI token', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', dailyBudgetUsd: '0.01', dailyBudgetScopeType: 'feature' });
    gw.mockFindActivePrice.mockResolvedValue({ id: 'p', pricePerUnit: '20.00', unitSize: '1000000', currency: 'USD' });
    gw.mockReservationsReserve.mockResolvedValue({
      reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'BUDGET_EXCEEDED', blockedDetail: 'feature:conversation.realtime_usage',
    });

    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 1800);
    expect(result).toEqual({ allowed: false, reservationId: null, blockedReason: 'BUDGET_EXCEEDED' });
  });

  it('an unpriced metric against a configured budget sends a NULL estimate (never $0) to reserve()', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', monthlyBudgetUsd: '100.00', monthlyBudgetScopeType: 'global' });
    gw.mockFindActivePrice.mockResolvedValue(null); // no price registered yet
    await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 60);
    const params = gw.mockReservationsReserve.mock.calls[0][0] as ReserveUsageParams;
    expect(params.estimatedCostUsd).toBeNull();
  });

  it('a reservation infrastructure failure fails closed (blocked) rather than silently allowing the session', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', dailyBudgetUsd: '5.00' });
    gw.mockFindActivePrice.mockResolvedValue({ id: 'p', pricePerUnit: '1', unitSize: '1000000', currency: 'USD' });
    gw.mockReservationsReserve.mockRejectedValue(new Error('rpc down'));
    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 60);
    expect(result).toEqual({ allowed: false, reservationId: null, blockedReason: 'BUDGET_EXCEEDED' });
  });

  it('a policy-resolution failure fails OPEN (never blocks a session over a transient policy hiccup when nothing is even known to be configured)', async () => {
    gw.mockPolicyResolvePolicy.mockRejectedValue(new Error('policy db down'));
    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 60);
    expect(result).toEqual({ allowed: true, reservationId: null, blockedReason: null });
    expect(gw.mockReservationsReserve).not.toHaveBeenCalled();
  });

  it('two concurrent sessions racing the same remaining budget: a stateful mock proves only one gets through', async () => {
    // Mirrors enforcement.test.ts's acceptance-scenario pattern: the mock
    // stands in for reserve_gateway_usage_v1's real atomic row-lock
    // behavior (validated at the SQL level by that migration's own inline
    // self-tests) — this proves the TS layer wires a request each
    // concurrent call would need for that atomicity to actually protect it.
    let reservedSoFarUsd = 0;
    const LIMIT = 0.06;
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', dailyBudgetUsd: String(LIMIT), dailyBudgetScopeType: 'feature' });
    gw.mockFindActivePrice.mockImplementation(async ({ metricKey }: { metricKey: string }) => {
      if (metricKey === 'input_audio_tokens') return { id: 'p-in', pricePerUnit: '10.00', unitSize: '1000000', currency: 'USD' };
      if (metricKey === 'output_audio_tokens') return { id: 'p-out', pricePerUnit: '20.00', unitSize: '1000000', currency: 'USD' };
      return null;
    });
    gw.mockReservationsReserve.mockImplementation(async (params: ReserveUsageParams) => {
      const cost = Number(params.estimatedCostUsd);
      if (reservedSoFarUsd + cost > LIMIT) {
        return { reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'BUDGET_EXCEEDED', blockedDetail: 'feature:conversation.realtime_usage' };
      }
      reservedSoFarUsd += cost;
      return { reservationId: `res-${reservedSoFarUsd}`, status: 'pending', expiresAt: new Date(2000).toISOString() };
    });

    // Each 100s session costs $0.05 (see the cost-computation test above) —
    // two of them ($0.10) cannot both fit in a $0.06 budget.
    const [r1, r2] = await Promise.all([
      reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 100),
      reserveRealtimeSessionBudget(gw.mockDeps, 'user-2', 'openai', 'gpt-realtime-2.1-mini', 100),
    ]);

    const allowed = [r1, r2].filter((r) => r.allowed);
    const blocked = [r1, r2].filter((r) => !r.allowed);
    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].blockedReason).toBe('BUDGET_EXCEEDED');
  });

  it('a session near the remaining Realtime budget limit is refused when its ceiling would exceed what remains ("Realtime próximo ao limite")', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled', monthlyBudgetUsd: '0.04', monthlyBudgetScopeType: 'feature' });
    gw.mockFindActivePrice.mockImplementation(async ({ metricKey }: { metricKey: string }) => {
      if (metricKey === 'input_audio_tokens') return { id: 'p-in', pricePerUnit: '10.00', unitSize: '1000000', currency: 'USD' };
      if (metricKey === 'output_audio_tokens') return { id: 'p-out', pricePerUnit: '20.00', unitSize: '1000000', currency: 'USD' };
      return null;
    });
    // A real reserve_gateway_usage_v1 would see committed+reserved already
    // at $0.03 of a $0.04 limit — only $0.01 remains, but this session's
    // own 100s ceiling costs $0.05 (see above).
    gw.mockReservationsReserve.mockResolvedValue({
      reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'BUDGET_EXCEEDED', blockedDetail: 'feature:conversation.realtime_usage',
    });

    const result = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-1', 'openai', 'gpt-realtime-2.1-mini', 100);
    expect(result.allowed).toBe(false);
  });
});

// releaseRealtimeSessionBudget was removed — reconciliation (commit real
// cost, or release when nothing was consumed) now goes through the generic
// api/_ai-gateway/reservation-reconciliation.ts, shared with
// pronunciation.assess_text. See api/__tests__/reservation-reconciliation.test.ts.
