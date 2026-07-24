/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Closes the "reserve/release only, real cost never committed" gap for
 * client-driven bridge sessions (conversation.realtime_usage,
 * pronunciation.assess_text). Their physical calls happen entirely in the
 * browser, so there is no invoke() for executeEnforcedPipeline to wrap and
 * therefore no natural point where commit_gateway_reservation_v1 gets
 * called with the real cost — before this module, the only two things ever
 * done to their upfront reservation were reserve() and a blind release(),
 * which meant ai_gateway_budget_buckets.committed_cost_usd never grew from
 * real spend on these two features: once a session ended, the budget
 * silently looked fully available again even though real money had already
 * been spent (tracked correctly in usage_daily, but invisible to
 * reserve_gateway_usage_v1's own atomic ledger, which is what actually
 * gates the NEXT reservation attempt).
 *
 * Fix: at the session's real completion event, sum its ACTUAL recorded
 * cost (already correctly calculated per-response by the existing
 * reconcileEventCost path) and convert the reservation atomically into
 * committed_cost_usd via commit_gateway_reservation_v1 — the exact same
 * function every backend-wrapped feature already uses. That function
 * already: releases exactly the originally-reserved amount and commits
 * whatever the real cost is (so "release only the difference" and "commit
 * an overage in full, never capped" are both already correct there,
 * unchanged); its own WHERE status='pending' guard makes commit()/release()
 * inherently idempotent — a duplicate completion call is a safe no-op.
 *
 * usage_daily is NEVER the only accumulation for these two features from
 * this point on: ai_gateway_budget_buckets.committed_cost_usd — the ledger
 * reserve_gateway_usage_v1 actually reads — now reflects their real spend
 * too.
 */

import type { GatewayDeps } from './gateway';
import type { AiFeatureKey } from './feature-catalog';
import { summarizeSessionCost } from './session-cost-summary';

/**
 * Called when a client-driven bridge session reaches its real, final usage
 * event (conversation.realtime_usage's last response.done, or
 * pronunciation.assess_text's single completion event). Sums every
 * SUCCEEDED event this session recorded for featureKey and:
 *   - eventCount === 0            -> release() in full (nothing was ever consumed)
 *   - not every event costed yet  -> markReconciliationRequired() (never guess,
 *                                    never release capacity for spend whose
 *                                    size we cannot yet prove)
 *   - fully known real cost       -> commit() with that real total
 *
 * Best-effort: never throws. A failure partway through must never silently
 * release capacity that may have genuinely been consumed, so the fallback
 * on any unexpected error is markReconciliationRequired, not a swallowed
 * no-op.
 */
export async function reconcileSessionReservation(
  gatewayDeps: GatewayDeps,
  featureKey: AiFeatureKey,
  reservationId: string,
  providerSessionRecordId: string,
): Promise<void> {
  if (!gatewayDeps.reservationsRepository) return;
  try {
    const events = await gatewayDeps.usageRepository.getSessionUsageEvents(featureKey, providerSessionRecordId);
    const summary = summarizeSessionCost(events);

    if (summary.eventCount === 0) {
      await gatewayDeps.reservationsRepository.release(reservationId, 'session_completed_no_usage');
      return;
    }

    if (!summary.allCosted || summary.totalCostUsd === null || summary.representativeEventId === null) {
      // Real usage happened but its cost isn't fully known yet (pricing
      // still resolving) — hold the reservation, exactly like
      // enforcement.ts's own commit-failure fallback.
      await gatewayDeps.reservationsRepository.markReconciliationRequired(reservationId, 'cost_not_yet_calculated');
      return;
    }

    await gatewayDeps.reservationsRepository.commit(reservationId, summary.representativeEventId, summary.totalCostUsd);
  } catch (e) {
    gatewayDeps.logger('gateway.sessionReservation.reconcile.failed', { message: String(e) });
    await gatewayDeps.reservationsRepository.markReconciliationRequired(reservationId, 'reconcile_failed').catch(() => undefined);
  }
}

/**
 * Releases a reservation with NO reconciliation attempt — for paths that
 * already know, structurally, that no physical call was ever made (e.g.
 * pronunciation.assess_text's /fail bridge, reached before the Speech SDK
 * step ever ran). Best-effort and idempotent (release_gateway_reservation_v1's
 * own WHERE status='pending' guard).
 */
export async function releaseSessionReservation(gatewayDeps: GatewayDeps, reservationId: string, reason: string): Promise<void> {
  if (!gatewayDeps.reservationsRepository) return;
  try {
    await gatewayDeps.reservationsRepository.release(reservationId, reason);
  } catch (e) {
    gatewayDeps.logger('gateway.sessionReservation.release.failed', { message: String(e) });
  }
}
