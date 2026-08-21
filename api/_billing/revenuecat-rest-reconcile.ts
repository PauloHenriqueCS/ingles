/**
 * SERVER-ONLY: reconcile a user's subscription state from RevenueCat's REST
 * /v1/subscribers snapshot — the ONE implementation, shared by:
 *
 *   - POST /api/subscription/sync (the app's post-purchase / app-foreground
 *     nudge), and
 *   - the RevenueCat webhook's TRANSFER branch, whose payload names the new
 *     owner but carries NO product_id/original_transaction_id, so the only way
 *     to learn what that user now owns is to re-read their state here.
 *
 * Keeping it in one place is what stops the webhook and /sync from drifting
 * (same product matching, same central sandbox policy inside
 * reconcileSubscriptionStateFromRest).
 *
 * `store` is taken from the REST response WE fetch with the secret key — never
 * from client input — and feeds isSandboxBlockedHere (see
 * revenuecat-environment.ts).
 *
 * Best-effort by contract: every failure path (missing key, network error,
 * non-OK response, malformed body, per-subscription reconcile error) logs and
 * returns instead of throwing, so a RevenueCat outage can never fail the
 * caller's request.
 */

import { safeLog } from '../_helpers';
import { getRevenueCatApiSecretKey } from '../_env';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { REVENUECAT_SUBSCRIPTION_PRODUCT_IDS } from '../../src/domain/subscription/revenuecat-catalog';
import { reconcileSubscriptionStateFromRest, baseStoreProductId } from './revenuecat-subscription-sync-service';
import { normalizeRevenueCatStore } from './revenuecat-environment';

const KNOWN_SUBSCRIPTION_PRODUCT_IDS: string[] = Object.values(REVENUECAT_SUBSCRIPTION_PRODUCT_IDS);

export interface RevenueCatSubscriberSubscription {
  purchase_date: string | null;
  expires_date: string | null;
  /** The REST subscriber response carries NO original_transaction_id, and
   *  store_transaction_id changes on every renewal — see
   *  reconcileSubscriptionStateFromRest, which reconciles by state, not txn. */
  store_transaction_id?: string | null;
  unsubscribe_detected_at?: string | null;
  is_sandbox?: boolean;
  /** RevenueCat's store for this subscription (e.g. 'app_store', 'play_store').
   *  Server-side truth from the response WE fetch with the secret key. */
  store?: string | null;
}

interface RevenueCatSubscriberResponse {
  subscriber?: {
    subscriptions?: Record<string, RevenueCatSubscriberSubscription>;
  };
}

/**
 * Re-read `userId`'s subscriptions from RevenueCat and reconcile each known
 * product into user_plan_assignments. Never throws.
 *
 * @param logRoute route label for safeLog, so each caller keeps its own
 *   log namespace ('subscription/sync' vs 'billing/revenuecat-webhook').
 */
export async function reconcileSubscriptionsFromRevenueCatRest(
  userId: string,
  logRoute: string,
): Promise<void> {
  const apiKey = getRevenueCatApiSecretKey();
  if (!apiKey) return;

  let response: Response;
  try {
    response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    safeLog(logRoute, 'revenuecat_lookup_error', 502);
    return;
  }

  if (!response.ok) {
    // 404 = no subscriber record yet (never purchased) — expected, not an error.
    if (response.status !== 404) {
      safeLog(logRoute, 'revenuecat_lookup_failed', response.status);
    }
    return;
  }

  let body: RevenueCatSubscriberResponse;
  try {
    body = (await response.json()) as RevenueCatSubscriberResponse;
  } catch {
    safeLog(logRoute, 'revenuecat_response_invalid', 502);
    return;
  }

  const subscriptions = body.subscriber?.subscriptions ?? {};
  const supabase = getSharedServiceClient();
  const knownProductIds = new Set<string>(KNOWN_SUBSCRIPTION_PRODUCT_IDS);

  // RevenueCat keys `subscriptions` by the STORE product id: bare on Apple, but
  // 'productId:basePlanId' on Google Play. Match on the BASE product id so a
  // Google base-plan subscription is never silently skipped, then reconcile by
  // CURRENT STATE (never by transaction — the REST response has no
  // original_transaction_id and its store_transaction_id changes each renewal).
  for (const [storeProductId, sub] of Object.entries(subscriptions)) {
    if (!sub || !knownProductIds.has(baseStoreProductId(storeProductId))) continue;
    try {
      await reconcileSubscriptionStateFromRest(
        {
          appUserId: userId,
          environment: sub.is_sandbox ? 'SANDBOX' : 'PRODUCTION',
          // Derived from the RevenueCat REST subscriber response (server-side,
          // secret-key auth) — never the client request body.
          store: normalizeRevenueCatStore(sub.store),
          productId: storeProductId,
          purchaseDateMs: sub.purchase_date ? new Date(sub.purchase_date).getTime() : null,
          expiresDateMs: sub.expires_date ? new Date(sub.expires_date).getTime() : null,
          unsubscribeDetectedAtMs: sub.unsubscribe_detected_at ? new Date(sub.unsubscribe_detected_at).getTime() : null,
          storeTransactionId: sub.store_transaction_id ?? null,
        },
        { supabase },
      );
    } catch {
      safeLog(logRoute, 'reconcile_failed', 500, { productId: baseStoreProductId(storeProductId) });
    }
  }
}
