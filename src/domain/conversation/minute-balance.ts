/**
 * THE single formula for the conversation minute balance — plan-included
 * remaining, purchased extra remaining, and their total. Used by BOTH the
 * "Minutos adicionais" screen (via the server balance in GET
 * /api/conversation/minute-packages, which calls this) AND the conversation
 * screen's balance indicator, so the two can never diverge (the audited bug:
 * the conversation screen showed only plan minutes and ignored purchased ones).
 *
 * All values are SECONDS (matching FeatureLimit.limit/consumed and
 * ConversationEntitlements.extraSecondsAvailable). Consumption order stays
 * plan-included first, purchased credits second (see compute-feature-state.ts /
 * the debit RPC) — this only DERIVES the display split, never changes gating.
 */
export interface MinuteBalanceModel {
  /** Internal/unlimited plans — no finite counter should be shown. */
  unlimited: boolean;
  /** Plan-included seconds still available this period (0 when unlimited). */
  planRemainingSeconds: number;
  /** Purchased extra credit seconds still available. */
  extraRemainingSeconds: number;
  /** planRemaining + extraRemaining (extra alone when unlimited). */
  totalRemainingSeconds: number;
}

export function deriveMinuteBalance(
  monthlyLimitSeconds: number,
  monthlyConsumedSeconds: number,
  unlimited: boolean,
  extraSecondsAvailable: number,
): MinuteBalanceModel {
  const extra = Math.max(0, extraSecondsAvailable);
  if (unlimited) {
    return { unlimited: true, planRemainingSeconds: 0, extraRemainingSeconds: extra, totalRemainingSeconds: extra };
  }
  const plan = Math.max(0, monthlyLimitSeconds - monthlyConsumedSeconds);
  return { unlimited: false, planRemainingSeconds: plan, extraRemainingSeconds: extra, totalRemainingSeconds: plan + extra };
}
