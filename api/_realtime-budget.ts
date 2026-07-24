/**
 * SERVER-ONLY — upfront AI Gateway budget reservation for a Realtime
 * (conversation.realtime_usage) session.
 *
 * conversation.realtime_usage is billed per-token, but the physical calls
 * happen entirely in the browser via WebRTC — there is no invoke() for
 * executeAiGatewayCall to wrap (the same documented limitation already
 * covering conversation.webrtc_connect and pronunciation.assess_text), so
 * the enforce-mode reservation pipeline (enforcement.ts) is never reached
 * for this feature's real cost. Without some upfront gate, a session could
 * run its entire authorized duration even though the remaining budget was
 * already exhausted the instant it started.
 *
 * Fix: before minting the OpenAI ephemeral token, reserve a REAL,
 * conservative worst-case cost for the session's full authorized duration —
 * the same atomic reserve_gateway_usage_v1 primitive (and the same
 * centralized cost-estimator) every other enforce-mode feature uses, never a
 * per-feature duplicate estimate — sized from OpenAI's own documented
 * Realtime audio-token rates (see the constants below). If the full
 * ceiling's worst case does not fit in the remaining budget, session
 * creation is refused entirely — no OpenAI call is ever made for that
 * session — rather than issuing a token and hoping mid-session polling
 * catches it later ("bloqueia na próxima chamada" is explicitly not
 * acceptable). Two sessions starting concurrently against the same
 * near-exhausted budget are correctly serialized by
 * reserve_gateway_usage_v1's own deterministic row locks — only as many as
 * actually fit are ever allowed through.
 *
 * CORRECTION (2026-07-24 follow-up): this reservation used to be RELEASED
 * — never committed — once the session ended. That was a real gap, not an
 * acceptable simplification: once released, ai_gateway_budget_buckets
 * (the ledger reserve_gateway_usage_v1 actually reads) forgot the spend
 * entirely, even though the real cost was genuinely happening and correctly
 * recorded in usage_daily — a session could end and the budget would look
 * fully available again despite real money already spent. The session's
 * real cost is now reconciled — committed atomically, or the excess/deficit
 * against the original reservation resolved — via
 * api/_ai-gateway/reservation-reconciliation.ts's reconcileSessionReservation,
 * called from /session-complete and from the abandoned-session sweep (see
 * api/internal/listening/[...slug].ts's handleConversationSweep). This
 * module (_realtime-budget.ts) only sizes and creates the UPFRONT
 * reservation; reconciliation lives in the shared module so
 * pronunciation.assess_text (api/pronunciation/[...slug].ts) uses the exact
 * same real-cost-commit logic instead of a second, drifting copy.
 */

import type { GatewayDeps } from './_ai-gateway/gateway';
import { buildBudgetScopes, estimateConservativeCostUsd } from './_ai-gateway/index';
import type { GatewayCallContext } from './_ai-gateway/index';
import { REALTIME_MAX_SESSION_SECONDS } from './_realtime-constants';

const REALTIME_USAGE_FEATURE_KEY = 'conversation.realtime_usage';

// Documented at https://developers.openai.com/api/docs/guides/realtime-costs
// (verified 2026-07-24): input audio is billed at 1 token per 100ms of audio
// (10 tokens/sec), output audio at 1 token per 50ms of audio (20
// tokens/sec). Treating both as flowing SIMULTANEOUSLY at their ceiling for
// the whole authorized duration is deliberately over-conservative (a real
// full-duplex exchange alternates speaking/listening, it does not sustain
// both directions at their cap every instant) — a genuine upper bound,
// never a claim of precision (same "não alegar precisão exata se for upper
// bound" principle as estimators.ts's DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE).
const CONSERVATIVE_INPUT_AUDIO_TOKENS_PER_SECOND = 10;
const CONSERVATIVE_OUTPUT_AUDIO_TOKENS_PER_SECOND = 20;

export interface RealtimeBudgetReservation {
  allowed: boolean;
  reservationId: string | null;
  blockedReason: 'QUOTA_EXCEEDED' | 'BUDGET_EXCEEDED' | null;
}

/**
 * Reserves (or determines no reservation is needed) BEFORE the OpenAI
 * client_secrets token is minted. maxAuthorizedSeconds should be the
 * already-computed technical/commercial ceiling for this call
 * (authorizedAtStart.authorizedMaxRecordingSeconds) — this never loosens
 * that ceiling, it only additionally gates whether the call may start at
 * all.
 */
export async function reserveRealtimeSessionBudget(
  gatewayDeps: GatewayDeps,
  userId: string,
  provider: string,
  model: string,
  maxAuthorizedSeconds: number,
): Promise<RealtimeBudgetReservation> {
  if (!gatewayDeps.reservationsRepository || !(maxAuthorizedSeconds > 0)) {
    return { allowed: true, reservationId: null, blockedReason: null };
  }

  const context: GatewayCallContext = {
    featureKey: REALTIME_USAGE_FEATURE_KEY, provider, userId, actorType: 'user', executionLocation: 'mixed',
  };

  let budgetScopes: ReturnType<typeof buildBudgetScopes>;
  try {
    const policy = await gatewayDeps.policyResolver.resolvePolicy(context);
    budgetScopes = buildBudgetScopes(policy, context, REALTIME_USAGE_FEATURE_KEY, new Date(gatewayDeps.clock()));
  } catch (e) {
    gatewayDeps.logger('gateway.realtimeBudgetPolicy.failed', { message: String(e) });
    // Policy itself is unresolvable — same fail-safe default as
    // GatewayPolicyResolver's own catch (legacy/no budget), never blocks a
    // session over a transient policy-fetch hiccup when nothing is even
    // known to be configured.
    return { allowed: true, reservationId: null, blockedReason: null };
  }
  if (budgetScopes.length === 0) {
    // No budget configured anywhere for this scope — nothing to reserve
    // against, same "never restricts when unconfigured" principle as
    // enforcement.ts. Matches today's production reality (every scope's
    // daily/monthly budget is NULL).
    return { allowed: true, reservationId: null, blockedReason: null };
  }

  const ceilingSeconds = Math.max(1, Math.ceil(maxAuthorizedSeconds));
  const worstCaseMetrics = [
    { metricKey: 'input_audio_tokens', quantity: ceilingSeconds * CONSERVATIVE_INPUT_AUDIO_TOKENS_PER_SECOND },
    { metricKey: 'output_audio_tokens', quantity: ceilingSeconds * CONSERVATIVE_OUTPUT_AUDIO_TOKENS_PER_SECOND },
  ];

  const costEstimate = await estimateConservativeCostUsd(
    { provider, service: 'realtime', model, metrics: worstCaseMetrics },
    gatewayDeps.pricingRepository,
    new Date(gatewayDeps.clock()),
  );
  // Unresolved (no active price for these metrics) against a scope that DOES
  // have a configured budget — cannot prove affordability; reserve() itself
  // (backed by the corrected reserve_gateway_usage_v1) fails this closed
  // rather than letting the session start "for free" on paper.
  const estimatedCostUsd = costEstimate.resolved ? costEstimate.totalCostUsd : null;

  try {
    const reservation = await gatewayDeps.reservationsRepository.reserve({
      idempotencyKey: gatewayDeps.uuidGen(),
      userId,
      initiatedByUserId: userId,
      featureKey: REALTIME_USAGE_FEATURE_KEY,
      provider,
      model,
      estimatedMetrics: worstCaseMetrics,
      budgetScopes,
      estimatedCostUsd,
      expiresInSeconds: REALTIME_MAX_SESSION_SECONDS,
    });
    if (reservation.status === 'blocked') {
      return { allowed: false, reservationId: null, blockedReason: reservation.blockedReason ?? 'BUDGET_EXCEEDED' };
    }
    return { allowed: true, reservationId: reservation.reservationId, blockedReason: null };
  } catch (e) {
    gatewayDeps.logger('gateway.realtimeBudgetReserve.failed', { message: String(e) });
    // Reservation infrastructure failure against a scope that DOES have a
    // configured budget — matches enforcement.ts's own RESERVATION_FAILED
    // philosophy (fail closed): the closest honest signal to "we cannot
    // currently prove this call is affordable" is to block it, not to
    // silently let it through as if no budget existed.
    return { allowed: false, reservationId: null, blockedReason: 'BUDGET_EXCEEDED' };
  }
}
