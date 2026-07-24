/**
 * Unit tests for api/_ai-gateway/reservation-reconciliation.ts — closes the
 * "reserve/release only" gap for client-driven bridge sessions
 * (conversation.realtime_usage, pronunciation.assess_text): their real
 * cost must be committed into ai_gateway_budget_buckets.committed_cost_usd,
 * not just tracked in usage_daily.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileSessionReservation, releaseSessionReservation, releaseExpiredPendingReservations } from '../_ai-gateway/reservation-reconciliation';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';

describe('reconcileSessionReservation', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
  });

  it('releases the reservation in full when the session recorded zero real usage events', async () => {
    gw.mockGetSessionUsageEvents.mockResolvedValue([]);
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockReservationsRelease).toHaveBeenCalledWith('res-1', 'session_completed_no_usage');
    expect(gw.mockReservationsCommit).not.toHaveBeenCalled();
  });

  it('commits the REAL summed cost of every recorded event — never the original reserved amount', async () => {
    gw.mockGetSessionUsageEvents.mockResolvedValue([
      { id: 'evt-1', calculatedCostUsd: '0.20' },
      { id: 'evt-2', calculatedCostUsd: '0.30' },
    ]);
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockReservationsCommit).toHaveBeenCalledWith('res-1', 'evt-2', '0.5');
    expect(gw.mockReservationsRelease).not.toHaveBeenCalled();
  });

  it('real cost GREATER than what was reserved is still committed in full — no truncation at this layer', async () => {
    gw.mockGetSessionUsageEvents.mockResolvedValue([{ id: 'evt-1', calculatedCostUsd: '5.00' }]); // far above a small reservation
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockReservationsCommit).toHaveBeenCalledWith('res-1', 'evt-1', '5'); // sumDecimalStrings normalizes trailing zeros
  });

  it('real cost LESS than what was reserved is committed as the exact real amount', async () => {
    gw.mockGetSessionUsageEvents.mockResolvedValue([{ id: 'evt-1', calculatedCostUsd: '0.01' }]);
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockReservationsCommit).toHaveBeenCalledWith('res-1', 'evt-1', '0.01');
  });

  it('marks reconciliation_required (never releases, never commits a guess) when a real event has not been costed yet', async () => {
    gw.mockGetSessionUsageEvents.mockResolvedValue([
      { id: 'evt-1', calculatedCostUsd: '0.20' },
      { id: 'evt-2', calculatedCostUsd: null },
    ]);
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockReservationsMarkReconciliationRequired).toHaveBeenCalledWith('res-1', 'cost_not_yet_calculated');
    expect(gw.mockReservationsCommit).not.toHaveBeenCalled();
    expect(gw.mockReservationsRelease).not.toHaveBeenCalled();
  });

  it('an unexpected failure marks reconciliation_required rather than silently doing nothing or releasing', async () => {
    gw.mockGetSessionUsageEvents.mockRejectedValue(new Error('db down'));
    await reconcileSessionReservation(gw.mockDeps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockReservationsMarkReconciliationRequired).toHaveBeenCalledWith('res-1', 'reconcile_failed');
    expect(gw.mockReservationsRelease).not.toHaveBeenCalled();
  });

  it('is a no-op when no reservationsRepository is configured', async () => {
    const deps = { ...gw.mockDeps, reservationsRepository: undefined };
    await reconcileSessionReservation(deps, 'conversation.realtime_usage', 'res-1', 'session-1');
    expect(gw.mockGetSessionUsageEvents).not.toHaveBeenCalled();
  });

  it('queries by the exact featureKey and providerSessionRecordId given — pronunciation.assess_text and conversation.realtime_usage never cross-contaminate', async () => {
    gw.mockGetSessionUsageEvents.mockResolvedValue([]);
    await reconcileSessionReservation(gw.mockDeps, 'pronunciation.assess_text', 'res-2', 'assessment-session-9');
    expect(gw.mockGetSessionUsageEvents).toHaveBeenCalledWith('pronunciation.assess_text', 'assessment-session-9');
  });
});

describe('releaseSessionReservation', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
  });

  it('releases with the given reason', async () => {
    await releaseSessionReservation(gw.mockDeps, 'res-1', 'assess_text_failed');
    expect(gw.mockReservationsRelease).toHaveBeenCalledWith('res-1', 'assess_text_failed');
  });

  it('a release failure is swallowed (logged), never thrown', async () => {
    gw.mockReservationsRelease.mockRejectedValue(new Error('rpc down'));
    await expect(releaseSessionReservation(gw.mockDeps, 'res-1', 'x')).resolves.toBeUndefined();
    expect(gw.mockLogger).toHaveBeenCalledWith('gateway.sessionReservation.release.failed', expect.any(Object));
  });

  it('is a no-op when no reservationsRepository is configured', async () => {
    const deps = { ...gw.mockDeps, reservationsRepository: undefined };
    await releaseSessionReservation(deps, 'res-1', 'x');
    expect(gw.mockReservationsRelease).not.toHaveBeenCalled();
  });
});

describe('releaseExpiredPendingReservations', () => {
  let gw: ReturnType<typeof createMockGatewayDeps>;

  beforeEach(() => {
    gw = createMockGatewayDeps();
    gw.resetDefaults();
  });

  it('releases every expired pending reservation for ordinary (backend-wrapped) features', async () => {
    gw.mockReservationsListExpiredPending.mockResolvedValue([
      { id: 'res-writing-1', featureKey: 'writing.evaluate_rewrite' },
      { id: 'res-writing-2', featureKey: 'writing.evaluate_rewrite' },
    ]);
    const result = await releaseExpiredPendingReservations(gw.mockDeps, '2026-07-25T00:00:00.000Z');
    expect(gw.mockReservationsListExpiredPending).toHaveBeenCalledWith('2026-07-25T00:00:00.000Z');
    expect(gw.mockReservationsRelease).toHaveBeenCalledWith('res-writing-1', 'expired_reservation_sweep');
    expect(gw.mockReservationsRelease).toHaveBeenCalledWith('res-writing-2', 'expired_reservation_sweep');
    expect(result.releasedCount).toBe(2);
  });

  it('never releases conversation.realtime_usage or pronunciation.assess_text reservations — those are only ever reconciled by session-aware logic', async () => {
    gw.mockReservationsListExpiredPending.mockResolvedValue([
      { id: 'res-convo-1', featureKey: 'conversation.realtime_usage' },
      { id: 'res-pron-1', featureKey: 'pronunciation.assess_text' },
      { id: 'res-writing-1', featureKey: 'writing.evaluate_rewrite' },
    ]);
    const result = await releaseExpiredPendingReservations(gw.mockDeps, '2026-07-25T00:00:00.000Z');
    expect(gw.mockReservationsRelease).toHaveBeenCalledTimes(1);
    expect(gw.mockReservationsRelease).toHaveBeenCalledWith('res-writing-1', 'expired_reservation_sweep');
    expect(result.releasedCount).toBe(1);
  });

  it('a single release failure never stops the rest — best-effort per row', async () => {
    gw.mockReservationsListExpiredPending.mockResolvedValue([
      { id: 'res-a', featureKey: 'writing.evaluate_rewrite' },
      { id: 'res-b', featureKey: 'writing.evaluate_rewrite' },
    ]);
    gw.mockReservationsRelease.mockRejectedValueOnce(new Error('rpc down'));
    const result = await releaseExpiredPendingReservations(gw.mockDeps, '2026-07-25T00:00:00.000Z');
    expect(gw.mockReservationsRelease).toHaveBeenCalledTimes(2);
    expect(result.releasedCount).toBe(1); // only the second (successful) release is counted
  });

  it('a listing failure returns releasedCount 0 rather than throwing', async () => {
    gw.mockReservationsListExpiredPending.mockRejectedValue(new Error('db down'));
    const result = await releaseExpiredPendingReservations(gw.mockDeps, '2026-07-25T00:00:00.000Z');
    expect(result.releasedCount).toBe(0);
    expect(gw.mockReservationsRelease).not.toHaveBeenCalled();
  });

  it('is a no-op when no reservationsRepository is configured', async () => {
    const deps = { ...gw.mockDeps, reservationsRepository: undefined };
    const result = await releaseExpiredPendingReservations(deps, '2026-07-25T00:00:00.000Z');
    expect(result.releasedCount).toBe(0);
  });
});
