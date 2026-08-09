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
  /** TRANSFER only — the app_user_id(s) the subscription moved to. */
  transferredTo?: string[] | null;
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

  if (isSandboxBlockedHere(event.environment)) {
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

  // Resolve the plan by DATA, never by plan name (see FASE 10). RevenueCat
  // sends each store's own product identifier: bare on Apple (== apple_product_id)
  // and, on Google Play, the subscription id plus its base plan, e.g.
  // "orodim.subscription.plus.monthly:monthly". So match plans.apple_product_id
  // OR plans.google_subscription_product_id, and tolerate the Android base-plan
  // suffix by also trying the id with everything after ':' stripped — the app
  // never depends on Apple ids to credit an Android purchase.
  const bareProductId = event.productId.split(':')[0];
  const productIdCandidates = Array.from(new Set([event.productId, bareProductId]));
  const planMatchFilter = productIdCandidates
    .flatMap((id) => [`apple_product_id.eq.${id}`, `google_subscription_product_id.eq.${id}`])
    .join(',');
  const { data: planRow, error: planError } = await supabase
    .from('plans')
    .select('id')
    .or(planMatchFilter)
    .maybeSingle();
  if (planError) throw new Error(`plans lookup failed: ${planError.message}`);
  if (!planRow) {
    return { ok: false, reason: 'unknown_product' };
  }

  const startsAtIso = event.purchasedAtMs ? new Date(event.purchasedAtMs).toISOString() : new Date().toISOString();
  const endsAtIso = event.expirationAtMs ? new Date(event.expirationAtMs).toISOString() : null;
  const isExpiredNow = event.type === 'EXPIRATION' || (endsAtIso !== null && new Date(endsAtIso).getTime() <= Date.now());

  const row: Record<string, unknown> = {
    user_id: targetUserId,
    plan_id: (planRow as { id: string }).id,
    version_policy: 'follow_current_published',
    origin: 'subscription',
    starts_at: startsAtIso,
    ends_at: endsAtIso,
    status: isExpiredNow ? 'expired' : 'active',
    created_by: targetUserId,
    reason: `RevenueCat ${event.type} (${event.environment})`,
    idempotency_key: `revenuecat:subscription:${event.originalTransactionId}`,
  };
  // Only these two event types ever touch cancellation fields — every
  // other event type omits the keys entirely, so the UPSERT's generated
  // DO UPDATE SET never clobbers an existing cancelled_at/cancel_reason.
  if (event.type === 'CANCELLATION') {
    row.cancelled_at = new Date().toISOString();
    row.cancel_reason = 'revenuecat_cancellation';
  } else if (event.type === 'UNCANCELLATION') {
    row.cancelled_at = null;
    row.cancel_reason = null;
  }

  const { error: upsertError } = await supabase
    .from('user_plan_assignments')
    .upsert(row, { onConflict: 'idempotency_key' });
  if (upsertError) throw new Error(`user_plan_assignments upsert failed: ${upsertError.message}`);

  return { ok: true, action: 'upserted_assignment' };
}
