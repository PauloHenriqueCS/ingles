import type { SubscriptionScreenState } from './subscription-types';
import { currentCommercialPlanCode, type PlanCardAction } from './subscription-plan-actions';
import { REVENUECAT_ENTITLEMENT_IDS } from './revenuecat-catalog';

/**
 * THE single source of truth for what the subscription screen shows. It folds
 * the two authorities that were previously read in isolation — the backend
 * (GET /api/subscription/status, access truth) and the store (RevenueCat
 * CustomerInfo, ownership truth) — into one coherent state, so the screen can
 * never again offer an action the store rejects (the "Assinar Essencial" →
 * "Você já possui este produto" bug: backend still said trial while the Play
 * Store already owned Essencial).
 *
 * Pure and unit-testable (this repo's vitest env is 'node', no DOM). The
 * component (SubscriptionView) owns the side effects — fetching, the one-shot
 * /sync reconciliation, the reconciling flag — and reads every decision from
 * here. Never re-derive a CTA anywhere else.
 *
 * Design rules baked in:
 *   - The backend remains access truth. The store can only prove the user owns
 *     MORE than the backend knows (a purchase not yet reconciled) → that
 *     triggers reconciliation. The store is never used to REVOKE access the
 *     backend still grants (a transient RevenueCat read must not downgrade a
 *     valid subscription — see `needsReconciliation`).
 *   - A plan the user already owns (per EITHER authority) is never offered as a
 *     fresh 'subscribe'. That is what makes purchasePackage() calls safe.
 *   - On web / an unconfigured SDK the store axis is simply unknown
 *     (supported=false) and this collapses to backend-only behaviour.
 */

export type AccessPlan = 'trial' | 'essential' | 'plus' | 'internal' | 'none';
export type StoreOwnership = 'none' | 'essential' | 'plus' | 'both';

/**
 * The one coherent screen state. 'reconciling' is a transient UI-only state the
 * component sets while its one-shot /sync is in flight (neutral "Atualizando
 * sua assinatura…"); every other value is derived from backend + store.
 * 'cancelled_active' = cancelled but still inside the paid period (access
 * continues until ends_at). 'pending_change' = the store reports a plan change
 * in flight (both entitlements briefly active). billing_issue keeps access, so
 * it maps to 'active' here — the existing view-model still renders its own copy.
 */
export type SubscriptionUiState =
  | 'reconciling'
  | 'trial'
  | 'active'
  | 'cancelled_active'
  | 'pending_downgrade'
  | 'pending_upgrade'
  | 'not_renewing'
  | 'expired'
  | 'internal'
  | 'billing_issue';

export type SubscriptionUiAction =
  | 'subscribe_essential'
  | 'subscribe_plus'
  | 'upgrade_to_plus'
  | 'downgrade_to_essential'
  | 'manage'
  | 'sync'
  | 'none';

/**
 * Minimal, store-agnostic projection of RevenueCat CustomerInfo for the
 * selector — sourced from useNativeSubscriptionPurchase. `supported` is false
 * on web and on a native build without its store key configured; `loaded`
 * turns true only after a getCustomerInfo() round-trip that ran while the SDK
 * was configured (so an unconfigured empty read never masquerades as "owns
 * nothing"). See revenueCatClient.getCustomerInfo / OrodimCustomerInfo.
 */
export interface StoreSubscriptionSnapshot {
  supported: boolean;
  loaded: boolean;
  activeEntitlementIds: readonly string[];
  managementUrl: string | null;
}

export interface ResolvedSubscriptionUiState {
  accessPlan: AccessPlan;
  storeOwnership: StoreOwnership;
  subscriptionState: SubscriptionUiState;
  availableActions: SubscriptionUiAction[];
  /** true when the store proves ownership of a commercial plan the backend has
   *  not yet reflected — the screen should run exactly ONE /sync then refetch
   *  /status. Never true on web / an unloaded store, and never true merely
   *  because the store reports LESS than the backend (that never syncs). */
  needsReconciliation: boolean;
  /** The commercial plan the user effectively holds now — the higher-ranked of
   *  what the backend and the store report, or null if neither. Used to resolve
   *  the current subscription's store product id for an upgrade/downgrade
   *  replacement even while the backend is momentarily stale. */
  currentPlan: 'essential' | 'plus' | null;
  /** The plan scheduled to take effect at the next renewal (backend
   *  pending_downgrade/pending_upgrade), or null. Its card shows "Próximo
   *  plano" and never re-offers the already-requested change. */
  pendingPlan: 'essential' | 'plus' | null;
  /** ISO timestamp the pending change takes effect, for the "agendada para
   *  DD/MM" copy. Null when there is no scheduled change. */
  effectiveChangeAt: string | null;
  /** Per-card resolved CTA, folding in ownership from BOTH authorities, so a
   *  plan the store already owns is 'current' (disabled), never 'subscribe'. */
  essentialCardAction: PlanCardAction;
  plusCardAction: PlanCardAction;
  /** The screen must disable every card CTA while reconciling (neutral state). */
  cardsDisabled: boolean;
}

type CommercialPlan = 'essential' | 'plus';
const PLAN_RANK: Record<CommercialPlan, number> = { essential: 1, plus: 2 };

/** Which commercial plan the store's active entitlements correspond to. Plus
 *  outranks Essencial when both are present ('both' ownership). Mirrors
 *  planCodeForActiveEntitlements but in the client display namespace. */
export function storeOwnershipFromEntitlements(activeEntitlementIds: readonly string[]): StoreOwnership {
  const active = new Set(activeEntitlementIds);
  const hasPlus = active.has(REVENUECAT_ENTITLEMENT_IDS.plus);
  const hasEssential = active.has(REVENUECAT_ENTITLEMENT_IDS.essencial);
  if (hasPlus && hasEssential) return 'both';
  if (hasPlus) return 'plus';
  if (hasEssential) return 'essential';
  return 'none';
}

function storeCommercialPlan(ownership: StoreOwnership): CommercialPlan | null {
  if (ownership === 'plus' || ownership === 'both') return 'plus';
  if (ownership === 'essential') return 'essential';
  return null;
}

/** The plan we treat as currently owned for CTA purposes — the higher-ranked
 *  of what the backend and the store each report, so neither authority alone
 *  can offer a re-purchase of something the other already owns. */
function effectiveCommercialPlan(
  backendPlan: CommercialPlan | null,
  storePlan: CommercialPlan | null,
): CommercialPlan | null {
  if (backendPlan && storePlan) return PLAN_RANK[backendPlan] >= PLAN_RANK[storePlan] ? backendPlan : storePlan;
  return backendPlan ?? storePlan;
}

function cardAction(card: CommercialPlan, owned: CommercialPlan | null): PlanCardAction {
  if (!owned) return 'subscribe';
  if (card === owned) return 'current';
  return PLAN_RANK[card] > PLAN_RANK[owned] ? 'upgrade' : 'downgrade';
}

/** As cardAction, but the plan a change is already SCHEDULED to becomes 'next'
 *  (locked, never re-offered) — so a pending downgrade never shows "Mudar para
 *  Essencial" again. */
function cardActionWithPending(
  card: CommercialPlan,
  owned: CommercialPlan | null,
  pendingPlan: CommercialPlan | null,
): PlanCardAction {
  if (pendingPlan && card === pendingPlan) return 'next';
  return cardAction(card, owned);
}

/** DB plan code (essencial/plus, Portuguese) → client display code. */
function dbCodeToDisplay(code: string | null): CommercialPlan | null {
  if (code === 'essencial') return 'essential';
  if (code === 'plus') return 'plus';
  return null;
}

/** The backend owns the commercial lifecycle; prefer its richer
 *  subscriptionState, falling back to legacy `status` for older responses / DEV
 *  mocks that don't set it. */
function uiStateFromBackend(backend: SubscriptionScreenState): SubscriptionUiState {
  switch (backend.subscriptionState) {
    case 'pending_downgrade': return 'pending_downgrade';
    case 'pending_upgrade': return 'pending_upgrade';
    case 'not_renewing': return 'not_renewing';
    case 'cancelled_active': return 'cancelled_active';
    case 'billing_issue': return 'billing_issue';
    case 'trialing': return 'trial';
    case 'expired': return 'expired';
    case 'active': return 'active';
    case 'internal': return 'internal';
    default:
      switch (backend.status) {
        case 'trialing': return 'trial';
        case 'canceled': return 'cancelled_active';
        case 'expired': return 'expired';
        case 'billing_issue': return 'billing_issue';
        default: return 'active';
      }
  }
}

function accessPlanFor(
  backend: SubscriptionScreenState,
  backendPlan: CommercialPlan | null,
): AccessPlan {
  if (backend.accessType === 'internal') return 'internal';
  if (backend.accessType === 'trial') return 'trial';
  if (backendPlan) return backendPlan;
  return 'none';
}

/**
 * @param reconciling — set true by the component ONLY while its one-shot /sync
 *   is actually in flight. It forces the neutral 'reconciling' state and
 *   disables the cards; it never triggers a sync itself (that is
 *   `needsReconciliation`).
 */
export function resolveSubscriptionUiState(
  backend: SubscriptionScreenState,
  store: StoreSubscriptionSnapshot,
  reconciling = false,
): ResolvedSubscriptionUiState {
  const storeKnown = store.supported && store.loaded;
  const storeOwnership: StoreOwnership = storeKnown
    ? storeOwnershipFromEntitlements(store.activeEntitlementIds)
    : 'none';

  const backendPlan = currentCommercialPlanCode(backend);
  const storePlan = storeCommercialPlan(storeOwnership);
  const owned = effectiveCommercialPlan(backendPlan, storePlan);

  const accessPlan = accessPlanFor(backend, backendPlan);

  // A backend-scheduled plan change (from the PRODUCT_CHANGE webhook). Only
  // trusted when the backend itself is in a pending state — never inferred from
  // the store (which can't see a Google Play DEFERRED change).
  const pendingPlan = dbCodeToDisplay(backend.pendingPlanCode ?? null);
  const effectiveChangeAt = pendingPlan ? backend.effectiveChangeAt ?? null : null;

  // The store proves ownership of a commercial plan the backend has not yet
  // reflected. Only ever fires when the store knows MORE (owns a commercial
  // plan the backend doesn't currently name) — never to revoke access.
  const needsReconciliation =
    backend.accessType !== 'internal' &&
    storeKnown &&
    storePlan !== null &&
    backendPlan !== storePlan;

  // ---- subscriptionState -------------------------------------------------
  // The backend owns the commercial lifecycle (pending / cancelled / not
  // renewing); the store only drives the trial-divergence reconciliation above.
  let subscriptionState: SubscriptionUiState;
  if (reconciling) {
    subscriptionState = 'reconciling';
  } else if (backend.accessType === 'internal') {
    subscriptionState = 'internal';
  } else {
    subscriptionState = uiStateFromBackend(backend);
  }

  // ---- per-card CTAs -----------------------------------------------------
  const essentialCardAction = cardActionWithPending('essential', owned, pendingPlan);
  const plusCardAction = cardActionWithPending('plus', owned, pendingPlan);

  // ---- availableActions (contract/telemetry view of the same decision) ---
  const availableActions: SubscriptionUiAction[] = [];
  if (reconciling || backend.accessType === 'internal') {
    availableActions.push('none');
  } else if (pendingPlan) {
    // A change is already scheduled — never offer another purchase/change;
    // only store management (if the store provides a URL).
    if (store.managementUrl || backend.canManageSubscription) availableActions.push('manage');
    if (availableActions.length === 0) availableActions.push('none');
  } else {
    if (!owned) {
      availableActions.push('subscribe_essential', 'subscribe_plus');
    } else if (owned === 'essential') {
      availableActions.push('upgrade_to_plus');
    } else {
      availableActions.push('downgrade_to_essential');
    }
    if (needsReconciliation) availableActions.push('sync');
    if (store.managementUrl || backend.canManageSubscription) availableActions.push('manage');
    if (availableActions.length === 0) availableActions.push('none');
  }

  return {
    accessPlan,
    storeOwnership,
    subscriptionState,
    availableActions,
    needsReconciliation,
    currentPlan: owned,
    pendingPlan,
    effectiveChangeAt,
    essentialCardAction,
    plusCardAction,
    cardsDisabled: reconciling,
  };
}
