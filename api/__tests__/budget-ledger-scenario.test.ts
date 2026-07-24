/**
 * End-to-end proof (application layer, stateful mock standing in for the
 * real ai_gateway_budget_buckets ledger reserve_gateway_usage_v1 /
 * commit_gateway_reservation_v1 / release_gateway_reservation_v1 maintain —
 * unchanged by this delivery except for the NULL-estimate fix in
 * 20260724030000_ai_gateway_conservative_budget_estimate_fix.sql, whose own
 * inline self-tests are the authoritative SQL-level proof for that specific
 * change) that conversation.realtime_usage and pronunciation.assess_text
 * now correctly:
 *   1. reserve conservatively before starting;
 *   2. reconcile the REAL cost once the session's final usage event lands;
 *   3. convert the reservation atomically into committed_cost_usd;
 *   4. release only the difference between what was reserved and the real cost;
 *   5. accumulate a real-cost overage in full, never capped at the reservation;
 *   6. are idempotent — finishing a session twice never double-commits/releases;
 *   7. (proven separately, in reservation-reconciliation.test.ts and the
 *      abandoned-session sweep tests in conversation-sweep.test.ts) never
 *      permanently return budget for cost that already happened when a
 *      session ends abnormally;
 * and that Conversation and Pronunciation genuinely compete for ONE shared
 * global budget bucket, not two independent copies of it.
 *
 * The stateful mock below mirrors reserve_gateway_usage_v1's real
 * arithmetic exactly (available = limit - committed - reserved; blocks when
 * the estimate exceeds available; commit releases the ORIGINAL reserved
 * amount in full and adds whatever the real cost is, uncapped; a
 * non-'pending' reservation is a no-op for both commit and release) — see
 * supabase/migrations/20260718000000_ai_gateway_enforcement.sql's
 * reserve_gateway_usage_v1/commit_gateway_reservation_v1/
 * release_gateway_reservation_v1 for the real SQL this simulates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import { reserveRealtimeSessionBudget } from '../_realtime-budget';
import { reconcileSessionReservation, releaseSessionReservation } from '../_ai-gateway/index';
import { reserveAssessTextBudget } from '../pronunciation/[...slug]';
import type { ReserveUsageParams, ReservationResult } from '../_ai-gateway/types';

// Worst-case audio-token rate baked into reserveRealtimeSessionBudget
// (10 input tokens/sec + 20 output tokens/sec — see api/_realtime-budget.ts).
// With a uniform price of $200 per 1,000,000 tokens ($0.0002/token) for both
// input_audio_tokens and output_audio_tokens, a T-second ceiling reserves
// exactly T * 30 * 0.0002 = T * 0.006 dollars — chosen so a 100-second
// ceiling reserves exactly $0.60, matching the required scenario.
const REALTIME_PRICE_PER_TOKEN_UNIT = { id: 'p', pricePerUnit: '200', unitSize: '1000000', currency: 'USD' };
const REALTIME_CEILING_FOR_060 = 100; // seconds -> $0.60 at the price above

function makeStatefulBudgetBucket(limitUsd: number) {
  let committedCostUsd = 0;
  let reservedCostUsd = 0;
  let counter = 0;
  const reservations = new Map<string, { estimatedCostUsd: number; status: 'pending' | 'committed' | 'released' }>();

  return {
    state: () => ({ committedCostUsd, reservedCostUsd, availableUsd: limitUsd - committedCostUsd - reservedCostUsd }),
    reserve: async (params: ReserveUsageParams): Promise<ReservationResult> => {
      if (params.estimatedCostUsd === null) {
        return { reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'BUDGET_EXCEEDED', blockedDetail: 'global:global:estimate_unavailable' };
      }
      const cost = Number(params.estimatedCostUsd);
      const available = limitUsd - committedCostUsd - reservedCostUsd;
      if (cost > Math.max(available, 0)) {
        return { reservationId: null, status: 'blocked', expiresAt: null, blockedReason: 'BUDGET_EXCEEDED', blockedDetail: 'global:global' };
      }
      const id = `res-${++counter}`;
      reservedCostUsd += cost;
      reservations.set(id, { estimatedCostUsd: cost, status: 'pending' });
      return { reservationId: id, status: 'pending', expiresAt: new Date(2000).toISOString() };
    },
    commit: async (reservationId: string, _usageEventId: string, actualCostUsd: string | null): Promise<void> => {
      const r = reservations.get(reservationId);
      if (!r || r.status !== 'pending') return; // WHERE status='pending' guard — idempotent
      reservedCostUsd = Math.max(0, reservedCostUsd - r.estimatedCostUsd);
      committedCostUsd += actualCostUsd !== null ? Number(actualCostUsd) : 0; // overage: never capped at r.estimatedCostUsd
      r.status = 'committed';
    },
    release: async (reservationId: string): Promise<void> => {
      const r = reservations.get(reservationId);
      if (!r || r.status !== 'pending') return; // WHERE status='pending' guard — idempotent
      reservedCostUsd = Math.max(0, reservedCostUsd - r.estimatedCostUsd);
      r.status = 'released';
    },
  };
}

describe('$1 global budget — full session lifecycle (reserve -> real usage -> commit -> next call sees the reduced balance)', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;
  let bucket: ReturnType<typeof makeStatefulBudgetBucket>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
    bucket = makeStatefulBudgetBucket(1.0);
    gw.mockReservationsReserve.mockImplementation(bucket.reserve);
    gw.mockReservationsCommit.mockImplementation(bucket.commit);
    gw.mockReservationsRelease.mockImplementation(bucket.release);
    gw.mockPolicyResolvePolicy.mockResolvedValue({
      gatewayMode: 'enforce', runtimeStatus: 'enabled', monthlyBudgetUsd: '1.00', monthlyBudgetScopeType: 'global',
    });
    gw.mockFindActivePrice.mockResolvedValue(REALTIME_PRICE_PER_TOKEN_UNIT);
  });

  it('runs the exact required scenario end to end', async () => {
    // 1. Session A reserves $0.60 conservatively, before any provider call.
    const sessionA = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-a', 'openai', 'gpt-realtime-2.1-mini', REALTIME_CEILING_FOR_060);
    expect(sessionA.allowed).toBe(true);
    expect(bucket.state()).toEqual({ committedCostUsd: 0, reservedCostUsd: 0.6, availableUsd: 0.4 });

    // 2/3. Session A's real final usage event lands with cost $0.50 ->
    // reconciled and converted atomically into committed_cost_usd.
    gw.mockGetSessionUsageEvents.mockResolvedValue([{ id: 'evt-a-final', calculatedCostUsd: '0.50' }]);
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', sessionA.reservationId!, 'session-a');

    // 4. Only the difference (the unused $0.10 of the original $0.60 hold)
    // was released — the bucket now shows exactly $0.50 committed, nothing
    // still reserved for session A.
    expect(bucket.state()).toEqual({ committedCostUsd: 0.5, reservedCostUsd: 0, availableUsd: 0.5 });

    // 5. Session B, trying to reserve the same $0.60 a fresh session A
    // would have needed, is blocked — BEFORE any provider call — because
    // only $0.50 now remains of the shared $1.00 budget.
    const sessionB = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-b', 'openai', 'gpt-realtime-2.1-mini', REALTIME_CEILING_FOR_060);
    expect(sessionB.allowed).toBe(false);
    expect(sessionB.blockedReason).toBe('BUDGET_EXCEEDED');
    expect(sessionB.reservationId).toBeNull();
    expect(bucket.state()).toEqual({ committedCostUsd: 0.5, reservedCostUsd: 0, availableUsd: 0.5 }); // unchanged by the blocked attempt

    // 6. Finalizing session A a SECOND time (e.g. a racing/retried
    // /session-complete call) must never double-commit.
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', sessionA.reservationId!, 'session-a');
    expect(bucket.state()).toEqual({ committedCostUsd: 0.5, reservedCostUsd: 0, availableUsd: 0.5 }); // exactly unchanged
    expect(gw.mockReservationsCommit).toHaveBeenCalledTimes(2); // called twice...
    // ...but the second call was a real no-op inside the (idempotent) SQL layer.
  });
});

describe('$1 global budget — real cost above the reservation is accumulated in full (overage never capped)', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;
  let bucket: ReturnType<typeof makeStatefulBudgetBucket>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
    bucket = makeStatefulBudgetBucket(1.0);
    gw.mockReservationsReserve.mockImplementation(bucket.reserve);
    gw.mockReservationsCommit.mockImplementation(bucket.commit);
    gw.mockReservationsRelease.mockImplementation(bucket.release);
    gw.mockPolicyResolvePolicy.mockResolvedValue({
      gatewayMode: 'enforce', runtimeStatus: 'enabled', monthlyBudgetUsd: '1.00', monthlyBudgetScopeType: 'global',
    });
    gw.mockFindActivePrice.mockResolvedValue(REALTIME_PRICE_PER_TOKEN_UNIT);
  });

  it('a session that reserved a small ceiling but really cost far more has the FULL real cost committed', async () => {
    // Reserve a small 10-second ceiling: 10 * 30 tokens * $0.0002 = $0.06.
    const session = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-c', 'openai', 'gpt-realtime-2.1-mini', 10);
    expect(session.allowed).toBe(true);
    expect(bucket.state().reservedCostUsd).toBe(0.06);

    // The session ran far longer than technically authorized turned out to
    // cost (implausible in practice given the ceiling IS the hard cap, but
    // this proves the commit path itself never truncates a real number
    // larger than what was reserved — the actual truncation guarantee lives
    // in the session-control polling loop, a separate protection).
    gw.mockGetSessionUsageEvents.mockResolvedValue([{ id: 'evt-c-final', calculatedCostUsd: '0.30' }]);
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', session.reservationId!, 'session-c');

    expect(bucket.state()).toEqual({ committedCostUsd: 0.3, reservedCostUsd: 0, availableUsd: 0.7 });
    expect(gw.mockReservationsCommit).toHaveBeenCalledWith(session.reservationId, 'evt-c-final', '0.3');

    // The full $0.30 (not the $0.06 originally reserved) now correctly
    // reduces what remains of the shared budget for the next reservation.
    const nextSession = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-d', 'openai', 'gpt-realtime-2.1-mini', REALTIME_CEILING_FOR_060 * 2); // wants $1.20
    expect(nextSession.allowed).toBe(false); // only $0.70 remains
  });
});

describe('$1 global budget — Conversation and Pronunciation contend for the SAME bucket', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;
  let bucket: ReturnType<typeof makeStatefulBudgetBucket>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
    bucket = makeStatefulBudgetBucket(1.0);
    gw.mockReservationsReserve.mockImplementation(bucket.reserve);
    gw.mockReservationsCommit.mockImplementation(bucket.commit);
    gw.mockReservationsRelease.mockImplementation(bucket.release);
    // Both features resolve the SAME global budget — as an administrator
    // configuring one shared cap actually intends (see the budget-scope
    // mislabeling fix in enforcement.ts's buildBudgetScopes).
    gw.mockPolicyResolvePolicy.mockResolvedValue({
      gatewayMode: 'enforce', runtimeStatus: 'enabled', dailyBudgetUsd: '1.00', dailyBudgetScopeType: 'global',
    });
  });

  it('conversation.realtime_usage reserving first reduces what pronunciation.assess_text can reserve afterward', async () => {
    gw.mockFindActivePrice.mockResolvedValue(REALTIME_PRICE_PER_TOKEN_UNIT); // used by both: audio_seconds price lookup below returns null for pronunciation unless matched
    // Conversation reserves $0.60 of the shared $1.00.
    const conversationSession = await reserveRealtimeSessionBudget(gw.mockDeps, 'user-a', 'openai', 'gpt-realtime-2.1-mini', REALTIME_CEILING_FOR_060);
    expect(conversationSession.allowed).toBe(true);
    expect(bucket.state().availableUsd).toBe(0.4);

    // Pronunciation now tries to reserve $0.50 worth of audio_seconds
    // (900s ceiling x a price chosen to land at $0.50) against the SAME
    // bucket, which only has $0.40 left — must be blocked.
    gw.mockFindActivePrice.mockImplementation(async ({ metricKey }: { metricKey: string }) =>
      metricKey === 'audio_seconds' ? { id: 'p2', pricePerUnit: '0.50', unitSize: '900', currency: 'USD' } : null,
    );
    const pronunciationSession = await reserveAssessTextBudget(gw.mockDeps, 'user-e', 900);
    // reserveAssessTextBudget is now fail-closed (independent audit
    // correction): a blocked reservation surfaces as allowed=false, never a
    // reservation id — the caller (handleStart) refuses to issue an Azure
    // token in this case.
    expect(pronunciationSession.allowed).toBe(false);
    expect(pronunciationSession.reservationId).toBeNull();
    expect(pronunciationSession.blockedReason).toBe('BUDGET_EXCEEDED');
    expect(gw.mockReservationsReserve).toHaveBeenCalledTimes(2); // both attempts genuinely went through reserve()
    const secondCallResult = await gw.mockReservationsReserve.mock.results[1].value;
    expect(secondCallResult.status).toBe('blocked');
    expect(bucket.state().availableUsd).toBe(0.4); // the blocked attempt changed nothing

    // Releasing Conversation's hold (session ended without ever really
    // costing anything) gives the FULL $1.00 back — and pronunciation's own
    // $0.50 request now fits, proving they were always drawing from the
    // exact same shared balance.
    await releaseSessionReservation(gw.mockDeps, conversationSession.reservationId!, 'test_cleanup');
    expect(bucket.state()).toEqual({ committedCostUsd: 0, reservedCostUsd: 0, availableUsd: 1 });

    const pronunciationRetry = await reserveAssessTextBudget(gw.mockDeps, 'user-e', 900);
    expect(pronunciationRetry.allowed).toBe(true); // now succeeds — a real reservation id
    expect(pronunciationRetry.reservationId).toBeTruthy();
    expect(bucket.state().reservedCostUsd).toBe(0.5);
  });
});
