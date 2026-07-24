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

// Feature keys with their own dedicated, session-based reconciliation (see
// reconcileSessionReservation above, and the abandoned-session sweep in
// api/internal/listening/[...slug].ts's handleConversationSweep). A blind
// release below would be wrong for these two specifically — real
// client-driven usage may still be waiting to be correlated against a usage
// event, and reconcileSessionReservation already knows how to do that
// safely. Every OTHER feature goes through executeEnforcedPipeline
// (enforcement.ts), where invoke() is fully contained within the SAME
// request lifecycle as the reservation itself (expiresInSeconds: 120) — a
// reservation still 'pending' long past that deadline can only mean the
// request died before its own success/failure path ever ran (function
// timeout, crash, mid-request redeploy), never that a physical call is
// still silently in flight days later.
const SESSION_RECONCILED_FEATURE_KEYS: ReadonlySet<AiFeatureKey> = new Set([
  'conversation.realtime_usage',
  'pronunciation.assess_text',
]);

/**
 * Releases every backend-wrapped (non-session) reservation still 'pending'
 * past its own expires_at — closes the gap executeEnforcedPipeline's own
 * release-on-invoke-error path can never reach, because there is no error
 * to catch when the process itself died mid-request (root cause confirmed,
 * read-only, for the pre-existing stuck writing.evaluate_rewrite
 * reservations this was added to fix). Best-effort and idempotent per
 * reservation (release_gateway_reservation_v1's own WHERE status='pending'
 * guard) — one failure never stops the rest. Intended to be called
 * periodically from the same cron sweep that already handles Conversation
 * and Pronunciation's own abandoned-session reconciliation.
 */
export async function releaseExpiredPendingReservations(
  gatewayDeps: GatewayDeps,
  nowIso: string = new Date(gatewayDeps.clock()).toISOString(),
): Promise<{ releasedCount: number }> {
  if (!gatewayDeps.reservationsRepository) return { releasedCount: 0 };
  let releasedCount = 0;
  try {
    const expired = await gatewayDeps.reservationsRepository.listExpiredPending(nowIso);
    for (const row of expired) {
      if (SESSION_RECONCILED_FEATURE_KEYS.has(row.featureKey)) continue;
      try {
        await gatewayDeps.reservationsRepository.release(row.id, 'expired_reservation_sweep');
        releasedCount++;
      } catch (e) {
        gatewayDeps.logger('gateway.expiredReservationSweep.releaseFailed', { reservationId: row.id, message: String(e) });
      }
    }
  } catch (e) {
    gatewayDeps.logger('gateway.expiredReservationSweep.listFailed', { message: String(e) });
  }
  return { releasedCount };
}
