import type { CommercialPlanCode, SubscriptionScreenState } from './subscription-types';

/**
 * Pure rules for what each commercial plan card offers, given the user's
 * current subscription state — extracted so they're unit-testable without
 * rendering (this repo's vitest env is 'node', no DOM). NEVER hides a plan: a
 * commercial plan the user isn't on is always offered as an upgrade or a
 * downgrade, never removed (the whole point of the redesign).
 *
 *   - 'subscribe' — the user has no commercial subscription (trial/expired/
 *                   none): a first purchase.
 *   - 'current'   — this card is the plan the user is on now (badge "Plano
 *                   atual", no purchase CTA). A cancelled-but-still-active
 *                   subscription is still 'current' (accessType stays
 *                   'commercial' until ends_at — see subscription-status-service).
 *   - 'upgrade'   — a higher-tier plan than the current one.
 *   - 'downgrade' — a lower-tier plan than the current one.
 *   - 'next'      — this plan is a SCHEDULED change already requested (a Google
 *                   Play DEFERRED downgrade). Badge "Próximo plano", no CTA —
 *                   the change is pending, never re-offered. Only the unified
 *                   selector (resolve-subscription-ui-state) produces this.
 */
export type PlanCardAction = 'subscribe' | 'current' | 'upgrade' | 'downgrade' | 'next';

/** Tier ordering by price — essential (R$34,90) < plus (R$59,90). Higher rank
 *  than the current plan is an upgrade, lower is a downgrade. */
const PLAN_RANK: Record<CommercialPlanCode, number> = { essential: 1, plus: 2 };

/**
 * The display-code (essential/plus) of the user's CURRENT commercial plan, or
 * null when they have no commercial subscription (trial, internal, expired,
 * none). Maps the backend's DB plan code (essencial/plus, Portuguese — see
 * revenuecat-catalog.ts) to the client display code. Only a genuine
 * 'commercial' accessType counts (a trial or the internal plan never does).
 */
export function currentCommercialPlanCode(state: SubscriptionScreenState): CommercialPlanCode | null {
  if (state.accessType !== 'commercial') return null;
  if (state.currentPlanCode === 'essencial') return 'essential';
  if (state.currentPlanCode === 'plus') return 'plus';
  return null;
}

export function planCardAction(cardCode: CommercialPlanCode, state: SubscriptionScreenState): PlanCardAction {
  const current = currentCommercialPlanCode(state);
  if (!current) return 'subscribe';
  if (cardCode === current) return 'current';
  return PLAN_RANK[cardCode] > PLAN_RANK[current] ? 'upgrade' : 'downgrade';
}

/** The store replacement semantics for a change action — upgrade applies
 *  immediately, downgrade is deferred to the next renewal (see
 *  revenueCatClient.purchasePackage). Used to pick the CTA label/hint and the
 *  OrodimPlanChangeMode passed to changePlan(). Null for non-change actions. */
export function planChangeMode(action: PlanCardAction): 'upgrade' | 'downgrade' | null {
  return action === 'upgrade' || action === 'downgrade' ? action : null;
}
