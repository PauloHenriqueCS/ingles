/**
 * SERVER-ONLY: reconciles a RevenueCat subscription lifecycle event into
 * public.user_plan_assignments — the backend remains the sole source of
 * truth for enforcement (api/_entitlements/plan-entitlements-service.ts);
 * this only writes the assignment row that service already reads.
 *
 * Design: reconcile by DATA, not by event-type name alone. Every lifecycle
 * event (INITIAL_PURCHASE, RENEWAL, CANCELLATION, UNCANCELLATION,
 * EXPIRATION, PRODUCT_CHANGE, SUBSCRIPTION_EXTENDED, REFUND_REVERSED,
 * TRANSFER) upserts the SAME assignment row, keyed by a stable idempotency
 * key derived from RevenueCat's original_transaction_id (stable across
 * renewals/product changes of the same subscription — see
 * user_plan_assignments.idempotency_key, already UNIQUE-indexed, no new
 * migration needed). starts_at/ends_at always come from the event's own
 * purchased_at_ms/expiration_at_ms — never invented. Only CANCELLATION and
 * UNCANCELLATION touch cancelled_at/cancel_reason; every other event type
 * leaves them untouched (Postgres UPSERT only updates the columns present
 * in the payload).
 *
 * A graceful cancellation (CANCELLATION with a future expiration_at_ms)
 * never changes status away from 'active' and never shortens ends_at —
 * matching the existing documented contract in
 * api/_entitlements/subscription-status-service.ts. Only when the event
 * itself reports an expiration in the past (EXPIRATION, or any event whose
 * expiration_at_ms has already elapsed) does status become 'expired' — a
 * real, already-existing value in user_plan_assignments' own status CHECK
 * constraint, never invented here.
 *
 * NON_RENEWING_PURCHASE (consumable minute packages) and TEST events never
 * reach this function — the webhook route handler
 * (revenuecat-webhook-route-handler.ts) dispatches those elsewhere before
 * calling this service at all.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { flagSubscriptionBillingIssue, clearSubscriptionBillingIssue } from '../_account/billing-block-repository';
import { isSandboxBlockedHere } from './revenuecat-environment';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Google Play appends the base plan id to the store product id (e.g.
 *  'orodim.subscription.plus.monthly:monthly'); Apple and consumables never
 *  do. Strips the ':basePlanId' suffix so a store product id can be compared
 *  against the base subscription id regardless of platform — the ONE place
 *  that ':basePlanId' rule lives (reconcileFromRevenueCat reuses it, so the
 *  webhook and the immediate sync normalize identically). */
export function baseStoreProductId(storeProductId: string): string {
  return storeProductId.split(':')[0];
}

/**
 * Resolve a plan id from a store product id by DATA, never by plan name (see
 * FASE 10). Matches plans.apple_product_id OR plans.google_subscription_product_id,
 * tolerating the Android base-plan suffix by also trying the ':'-stripped id.
 * Shared by the webhook (syncSubscriptionFromEvent) and the REST reconcile so
 * the mapping can never drift. Returns null when no plan matches.
 */
async function resolvePlanIdByStoreProductId(supabase: SupabaseClient, storeProductId: string): Promise<string | null> {
  const productIdCandidates = Array.from(new Set([storeProductId, baseStoreProductId(storeProductId)]));
  const planMatchFilter = productIdCandidates
    .flatMap((id) => [`apple_product_id.eq.${id}`, `google_subscription_product_id.eq.${id}`])
    .join(',');
  const { data: planRow, error: planError } = await supabase
    .from('plans')
    .select('id')
    .or(planMatchFilter)
    .maybeSingle();
  if (planError) throw new Error(`plans lookup failed: ${planError.message}`);
  return planRow ? (planRow as { id: string }).id : null;
}

/** Subscription-lifecycle event types this service reconciles. Anything
 *  else (NON_RENEWING_PURCHASE, TEST, paywall/analytics events, ...) is the
 *  route handler's responsibility to route elsewhere or acknowledge-only. */
export const SUBSCRIPTION_LIFECYCLE_EVENT_TYPES = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'CANCELLATION', 'UNCANCELLATION', 'EXPIRATION',
  'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED', 'TRANSFER',
]);

/** Events that represent a successful/resumed payment — always clear any
 *  previously flagged billing issue ("recuperação de cobrança"), via the
 *  existing user_billing_blocks structure, never an invented tolerance. */
const BILLING_RECOVERY_EVENT_TYPES = new Set(['RENEWAL', 'INITIAL_PURCHASE', 'UNCANCELLATION', 'REFUND_REVERSED']);

export interface RevenueCatLifecycleEvent {
  type: string;
  /** RevenueCat's app_user_id for this event — must be the Supabase UUID
   *  (see revenuecat-webhook-route-handler.ts, which never trusts anything
   *  else as identity). */
  appUserId: string;
  environment: string;
  productId: string | null;
  purchasedAtMs: number | null;
  expirationAtMs: number | null;
  originalTransactionId: string | null;
  /** PRODUCT_CHANGE only — the store product id the subscription is scheduled
   *  to change TO. For a Google Play DEFERRED downgrade this is the ONLY
   *  authoritative signal for the pending plan (the REST subscriber snapshot
   *  never names it — see reconcileSubscriptionStateFromRest). Null otherwise. */
  newProductId?: string | null;
  /** TRANSFER only — the app_user_id(s) the subscription moved to. */
  transferredTo?: string[] | null;
}

/** Monthly price of a plan, used ONLY to tell an upgrade from a downgrade on a
 *  PRODUCT_CHANGE (higher price = upgrade = immediate; lower = downgrade =
 *  DEFERRED). Never a display value. Null when the plan can't be read. */
async function planPriceCents(supabase: SupabaseClient, planId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('plans')
    .select('monthly_price_cents')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw new Error(`plans price lookup failed: ${error.message}`);
  return (data as { monthly_price_cents: number } | null)?.monthly_price_cents ?? null;
}

export type SyncOutcome =
  | { ok: true; action: 'upserted_assignment' | 'billing_issue_flagged' | 'ignored_not_lifecycle_event' }
  | { ok: false; reason: 'invalid_app_user_id' | 'unknown_product' | 'missing_original_transaction_id' | 'sandbox_blocked_in_production' };

export async function syncSubscriptionFromEvent(
  event: RevenueCatLifecycleEvent,
  deps?: { supabase?: SupabaseClient },
): Promise<SyncOutcome> {
  const supabase = deps?.supabase ?? getSharedServiceClient();

  if (!isValidUuid(event.appUserId)) {
    return { ok: false, reason: 'invalid_app_user_id' };
  }

  if (isSandboxBlockedHere(event.environment, event.appUserId)) {
    return { ok: false, reason: 'sandbox_blocked_in_production' };
  }

  const targetUserId = event.type === 'TRANSFER' && isValidUuid(event.transferredTo?.[0])
    ? (event.transferredTo as string[])[0]
    : event.appUserId;

  if (event.type === 'BILLING_ISSUE') {
    await flagSubscriptionBillingIssue(targetUserId);
    return { ok: true, action: 'billing_issue_flagged' };
  }
  if (BILLING_RECOVERY_EVENT_TYPES.has(event.type)) {
    await clearSubscriptionBillingIssue(targetUserId, 'system:revenuecat-webhook');
  }

  if (!SUBSCRIPTION_LIFECYCLE_EVENT_TYPES.has(event.type)) {
    return { ok: true, action: 'ignored_not_lifecycle_event' };
  }
  if (!event.productId) {
    return { ok: false, reason: 'unknown_product' };
  }
  if (!isValidUuid(targetUserId) || !event.originalTransactionId) {
    return { ok: false, reason: 'missing_original_transaction_id' };
  }

  // Resolve the plan by DATA, never by plan name (see FASE 10) — shared with
  // the REST reconcile via resolvePlanIdByStoreProductId.
  const planId = await resolvePlanIdByStoreProductId(supabase, event.productId);
  if (!planId) {
    return { ok: false, reason: 'unknown_product' };
  }

  const startsAtIso = event.purchasedAtMs ? new Date(event.purchasedAtMs).toISOString() : new Date().toISOString();
  const endsAtIso = event.expirationAtMs ? new Date(event.expirationAtMs).toISOString() : null;
  const isExpiredNow = event.type === 'EXPIRATION' || (endsAtIso !== null && new Date(endsAtIso).getTime() <= Date.now());

  const row: Record<string, unknown> = {
    user_id: targetUserId,
    plan_id: planId,
    version_policy: 'follow_current_published',
    origin: 'subscription',
    starts_at: startsAtIso,
    ends_at: endsAtIso,
    status: isExpiredNow ? 'expired' : 'active',
    created_by: targetUserId,
    reason: `RevenueCat ${event.type} (${event.environment})`,
    idempotency_key: `revenuecat:subscription:${event.originalTransactionId}`,
  };

  // Cancellation + pending-change fields are set per event type; every key NOT
  // added here is omitted from the UPSERT, so its existing value is preserved
  // (Postgres DO UPDATE SET only touches columns present in the payload).
  if (event.type === 'CANCELLATION') {
    // A real cancellation of THIS product — access continues until ends_at,
    // but it won't renew. Never touches pending_plan (a cancellation is not a
    // plan change). cancelled_at stays owned solely by this event type.
    row.cancelled_at = new Date().toISOString();
    row.cancel_reason = 'revenuecat_cancellation';
    row.auto_renew = false;
  } else if (event.type === 'UNCANCELLATION') {
    row.cancelled_at = null;
    row.cancel_reason = null;
    row.auto_renew = true;
    row.pending_plan_id = null;
    row.pending_effective_at = null;
  } else if (event.type === 'PRODUCT_CHANGE' && event.newProductId) {
    // The authoritative pending-plan signal. Distinguish an immediate upgrade
    // from a DEFERRED downgrade by price: a higher-priced target is an
    // immediate upgrade (activated by the target product's own
    // INITIAL_PURCHASE/RENEWAL — nothing pending on THIS row); a lower-priced
    // target is a Google Play DEFERRED downgrade that takes effect only at the
    // current product's period end.
    const newPlanId = await resolvePlanIdByStoreProductId(supabase, event.newProductId);
    const [currentPrice, newPrice] = newPlanId
      ? await Promise.all([planPriceCents(supabase, planId), planPriceCents(supabase, newPlanId)])
      : [null, null];
    const isDeferredDowngrade =
      newPlanId != null && newPlanId !== planId && currentPrice != null && newPrice != null && newPrice < currentPrice;
    if (isDeferredDowngrade) {
      row.pending_plan_id = newPlanId;
      row.pending_effective_at = endsAtIso; // current product's period end
      row.auto_renew = false; // the current product will not renew as-is
    } else {
      // Immediate upgrade (or an unresolvable/no-op change) — no pending change
      // lingers on this row.
      row.pending_plan_id = null;
      row.pending_effective_at = null;
      row.auto_renew = true;
    }
  } else if (!isExpiredNow) {
    // A fresh active period of this product (INITIAL_PURCHASE, RENEWAL,
    // SUBSCRIPTION_EXTENDED, REFUND_REVERSED, TRANSFER): it is renewing and
    // carries no scheduled change of its own. When a DEFERRED downgrade
    // effects, this is the target product's RENEWAL — clearing pending here is
    // exactly what returns the user to a clean 'active' on the new plan.
    row.auto_renew = true;
    row.pending_plan_id = null;
    row.pending_effective_at = null;
  }

  const { error: upsertError } = await supabase
    .from('user_plan_assignments')
    .upsert(row, { onConflict: 'idempotency_key' });
  if (upsertError) throw new Error(`user_plan_assignments upsert failed: ${upsertError.message}`);

  return { ok: true, action: 'upserted_assignment' };
}

/** Current-state snapshot of ONE subscription from RevenueCat's REST
 *  /v1/subscribers response (never a webhook event). Deliberately has NO
 *  original_transaction_id — the REST subscriber response does not provide one.
 *  store_transaction_id is the LAST observed transaction and CHANGES on every
 *  renewal (confirmed empirically), so it is reference/debug only, NEVER an
 *  identity key. */
export interface RevenueCatRestSubscriptionState {
  appUserId: string;
  environment: string;
  /** Store product id as keyed in `subscriber.subscriptions` (bare on Apple;
   *  may carry ':basePlanId' on Google). */
  productId: string;
  purchaseDateMs: number | null;
  expiresDateMs: number | null;
  /** RevenueCat's unsubscribe_detected_at — a graceful cancellation still keeps
   *  access until expires_date (mirrors the webhook CANCELLATION contract). */
  unsubscribeDetectedAtMs: number | null;
  /** Last observed store transaction — reference only, never identity. */
  storeTransactionId: string | null;
}

export type ReconcileStateOutcome =
  | { ok: true; action: 'reconciled_active' | 'reconciled_expired' }
  | { ok: false; reason: 'invalid_app_user_id' | 'unknown_product' | 'sandbox_blocked_in_production' };

/**
 * STATE reconciliation for POST /api/subscription/sync, from RevenueCat's REST
 * subscriber snapshot — NOT event-driven, and the counterpart to the webhook's
 * syncSubscriptionFromEvent. Because the REST subscriber response carries no
 * original_transaction_id and its store_transaction_id changes on every renewal,
 * identity here is the CURRENT STATE (user + plan), never a transaction:
 *
 *  - Exactly ONE commercial subscription assignment per (user, plan).
 *  - Renewal → the SAME row's starts_at/ends_at advance (never a new row).
 *  - Essential<->Plus → each product reconciles its own (user, plan) row; the
 *    now-expired plan's row falls out of admin_resolve_effective_plan_v1 by its
 *    past ends_at, and the active plan's row (latest starts_at) wins.
 *  - Idempotent by state: a repeated /sync with the same snapshot is a no-op
 *    (same values re-written), never a duplicate.
 *  - Coexists with the webhook: if an assignment already exists for
 *    (user, plan, origin='subscription') — including one the webhook created
 *    keyed by original_transaction_id — this UPDATES that same row instead of
 *    inserting a second one. Only when none exists does it INSERT, keyed by a
 *    STABLE per-(user, plan) idempotency key so two racing /sync calls can't
 *    double-insert.
 *
 * Never writes anything for a sandbox event on production unless the user is on
 * the REVENUECAT_SANDBOX_TEST_USER_IDS allowlist (same central policy as the
 * webhook, via isSandboxBlockedHere).
 */
export async function reconcileSubscriptionStateFromRest(
  state: RevenueCatRestSubscriptionState,
  deps?: { supabase?: SupabaseClient; now?: Date },
): Promise<ReconcileStateOutcome> {
  const supabase = deps?.supabase ?? getSharedServiceClient();
  const now = deps?.now ?? new Date();

  if (!isValidUuid(state.appUserId)) {
    return { ok: false, reason: 'invalid_app_user_id' };
  }
  if (isSandboxBlockedHere(state.environment, state.appUserId)) {
    return { ok: false, reason: 'sandbox_blocked_in_production' };
  }

  const planId = await resolvePlanIdByStoreProductId(supabase, state.productId);
  if (!planId) {
    return { ok: false, reason: 'unknown_product' };
  }

  const startsAtIso = state.purchaseDateMs ? new Date(state.purchaseDateMs).toISOString() : now.toISOString();
  const endsAtIso = state.expiresDateMs ? new Date(state.expiresDateMs).toISOString() : null;
  const isExpiredNow = endsAtIso !== null && new Date(endsAtIso).getTime() <= now.getTime();
  // unsubscribe_detected_at means "will not auto-renew as-is" — TRUE for BOTH a
  // real cancellation AND a Google Play DEFERRED downgrade, and the REST
  // snapshot cannot tell them apart or name a pending plan. So it drives ONLY
  // auto_renew here — never cancelled_at (that would render a pending downgrade
  // as "Assinatura cancelada", the bug) and never pending_plan (a guess). The
  // pending plan is set solely by the PRODUCT_CHANGE webhook, and a genuine
  // cancellation solely by the CANCELLATION webhook.
  const willNotRenew = state.unsubscribeDetectedAtMs != null;

  // Only the observed current-state columns — never user_id/plan_id (the state
  // identity + match key) and never idempotency_key (leave whatever created the
  // row, e.g. the webhook's original_transaction_id key, untouched). Also never
  // cancelled_at/pending_plan_id here — those belong to the webhook events.
  const stateFields: Record<string, unknown> = {
    version_policy: 'follow_current_published',
    origin: 'subscription',
    starts_at: startsAtIso,
    ends_at: endsAtIso,
    status: isExpiredNow ? 'expired' : 'active',
    // store_transaction_id kept only as a human-readable "last observed
    // transaction" reference — never an identity key.
    reason: `RevenueCat REST reconcile (${state.environment})${state.storeTransactionId ? ` [last_txn=${state.storeTransactionId}]` : ''}`,
    auto_renew: !willNotRenew,
  };

  // Reconcile the SAME (user, plan) subscription row the effective-plan RPC
  // would resolve (latest starts_at) — this is what makes renewals update in
  // place and lets a webhook-created row be reused instead of duplicated.
  const { data: existing, error: findError } = await supabase
    .from('user_plan_assignments')
    .select('id')
    .eq('user_id', state.appUserId)
    .eq('plan_id', planId)
    .eq('origin', 'subscription')
    .order('starts_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError) throw new Error(`user_plan_assignments lookup failed: ${findError.message}`);

  if (existing) {
    const { error: updateError } = await supabase
      .from('user_plan_assignments')
      .update(stateFields)
      .eq('id', (existing as { id: string }).id);
    if (updateError) throw new Error(`user_plan_assignments update failed: ${updateError.message}`);
    return { ok: true, action: isExpiredNow ? 'reconciled_expired' : 'reconciled_active' };
  }

  const idempotencyKey = `revenuecat:subscription:reconcile:${state.appUserId}:${baseStoreProductId(state.productId)}`;
  const insertRow = { ...stateFields, user_id: state.appUserId, plan_id: planId, created_by: state.appUserId, idempotency_key: idempotencyKey };
  const { error: insertError } = await supabase.from('user_plan_assignments').insert(insertRow);
  if (insertError) {
    // 23505 = a concurrent /sync inserted the same stable-keyed row first;
    // update it instead of failing (state reconciliation stays idempotent).
    if ((insertError as { code?: string }).code === '23505') {
      const { error: updErr } = await supabase
        .from('user_plan_assignments')
        .update(stateFields)
        .eq('idempotency_key', idempotencyKey);
      if (updErr) throw new Error(`user_plan_assignments update-after-conflict failed: ${updErr.message}`);
      return { ok: true, action: isExpiredNow ? 'reconciled_expired' : 'reconciled_active' };
    }
    throw new Error(`user_plan_assignments insert failed: ${insertError.message}`);
  }
  return { ok: true, action: isExpiredNow ? 'reconciled_expired' : 'reconciled_active' };
}
