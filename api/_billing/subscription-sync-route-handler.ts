/**
 * Handler for POST /api/subscription/sync — reached via a vercel.json
 * rewrite into api/grammar-explanation.ts (see the __lemonRoute branch
 * there), purely to stay within the Vercel Hobby plan's 12-serverless-
 * function cap. Grammar-explanation's own logic/URL are unaffected.
 *
 * Called by the app right after a purchase/restore/app-foreground, to
 * proactively reconcile before the RevenueCat webhook necessarily arrives
 * (webhooks can lag a few seconds). The webhook remains the authoritative,
 * always-on sync path — this is a nudge, never a second source of truth:
 * it ends by returning the exact same resolveSubscriptionStatus() snapshot
 * GET /api/subscription/status already returns.
 *
 * Identity: userId comes exclusively from the authenticated session
 * (requireAuth) — the request body is never read for a user id, app_user_id,
 * or plan. If REVENUECAT_API_SECRET_KEY isn't configured yet in this
 * environment, the RevenueCat lookup is skipped entirely (documented,
 * honest limitation — never a hard failure) and the endpoint still returns
 * the current backend-resolved status.
 */

import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog } from '../_helpers';
import { applyRateLimit } from '../_rateLimit';
import { getRevenueCatApiSecretKey } from '../_env';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { resolveSubscriptionStatus } from '../_entitlements/subscription-status-service';
import { REVENUECAT_SUBSCRIPTION_PRODUCT_IDS } from '../../src/domain/subscription/revenuecat-catalog';
import { syncSubscriptionFromEvent, baseStoreProductId, type RevenueCatLifecycleEvent } from './revenuecat-subscription-sync-service';
// TEMP DIAGNOSTIC (SYNC_DIAG_*, remove after root-cause) — sandbox allowlist visibility.
import { isSandboxTestUser, isSandboxBlockedHere } from './revenuecat-environment';

const KNOWN_SUBSCRIPTION_PRODUCT_IDS: string[] = Object.values(REVENUECAT_SUBSCRIPTION_PRODUCT_IDS);

interface RevenueCatSubscriberSubscription {
  purchase_date: string | null;
  expires_date: string | null;
  original_transaction_id?: string | null;
  is_sandbox?: boolean;
}

interface RevenueCatSubscriberResponse {
  subscriber?: {
    subscriptions?: Record<string, RevenueCatSubscriberSubscription>;
  };
}

/** Best-effort — never lets a RevenueCat outage break the endpoint. Every
 *  failure path falls through to still returning the current backend
 *  status (unchanged, webhook-driven) rather than an error. */
async function reconcileFromRevenueCat(userId: string): Promise<void> {
  const apiKey = getRevenueCatApiSecretKey();
  if (!apiKey) return;

  let response: Response;
  try {
    response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    safeLog('subscription/sync', 'revenuecat_lookup_error', 502);
    return;
  }

  if (!response.ok) {
    if (response.status !== 404) {
      // 404 = no subscriber record yet (never purchased) — expected, not an error.
      safeLog('subscription/sync', 'revenuecat_lookup_failed', response.status);
    } else {
      // TEMP DIAGNOSTIC (remove after root-cause): RevenueCat has no subscriber
      // record for this user at the moment /sync ran (the race hypothesis).
      safeLog('subscription/sync', 'SYNC_DIAG_no_subscriber', 404, { user: userId.slice(0, 8) + '…' });
    }
    return;
  }

  let body: RevenueCatSubscriberResponse;
  try {
    body = (await response.json()) as RevenueCatSubscriberResponse;
  } catch {
    safeLog('subscription/sync', 'revenuecat_response_invalid', 502);
    return;
  }

  const subscriptions = body.subscriber?.subscriptions ?? {};
  const supabase = getSharedServiceClient();
  const knownProductIds = new Set<string>(KNOWN_SUBSCRIPTION_PRODUCT_IDS);

  // TEMP DIAGNOSTIC (remove after root-cause): what the RevenueCat REST
  // subscriber snapshot actually contained when /sync ran — no secrets, no
  // tokens, no auth headers; app_user_id masked to its first 8 chars.
  const subscriptionKeys = Object.keys(subscriptions);
  safeLog('subscription/sync', 'SYNC_DIAG_subs', 200, {
    user: userId.slice(0, 8) + '…',
    keys: subscriptionKeys.join('|') || '(none)',
    count: subscriptionKeys.length,
  });

  // RevenueCat keys `subscriptions` by the STORE product id: bare on Apple,
  // but 'productId:basePlanId' on Google Play (e.g.
  // 'orodim.subscription.plus.monthly:monthly'). Iterate the real entries and
  // match on the BASE product id, so a Google base-plan subscription is never
  // silently skipped — indexing by the bare id would only ever match Apple.
  for (const [storeProductId, sub] of Object.entries(subscriptions)) {
    const base = baseStoreProductId(storeProductId);
    // TEMP DIAGNOSTIC (remove after root-cause): which transactional-identifier
    // fields the REST subscription entry actually carries — FIELD NAMES and
    // types only, never any value/token/id. This picks the correct idempotency
    // source (the code currently requires original_transaction_id, which the
    // REST subscriber response does not populate).
    const subObj = (sub ?? {}) as unknown as Record<string, unknown>;
    const typeOf = (k: string): string => (k in subObj ? typeof subObj[k] : 'absent');
    safeLog('subscription/sync', 'SYNC_DIAG_fields', 200, {
      user: userId.slice(0, 8) + '…',
      rawProductId: storeProductId,
      keys: Object.keys(subObj).join('|') || '(none)',
      has_original_transaction_id: 'original_transaction_id' in subObj,
      has_transaction_id: 'transaction_id' in subObj,
      has_store_transaction_id: 'store_transaction_id' in subObj,
      has_original_store_transaction_id: 'original_store_transaction_id' in subObj,
      has_purchase_token: 'purchase_token' in subObj,
      types: ['original_transaction_id', 'transaction_id', 'store_transaction_id', 'original_store_transaction_id', 'purchase_token']
        .map((k) => `${k}:${typeOf(k)}`)
        .join('|'),
    });
    // TEMP DIAGNOSTIC (remove after root-cause): raw vs normalized product id
    // and whether it matched a known plan.
    safeLog('subscription/sync', 'SYNC_DIAG_key', 200, {
      user: userId.slice(0, 8) + '…',
      rawProductId: storeProductId,
      baseProductId: base,
      matchedKnownPlan: knownProductIds.has(base),
      isSandbox: sub?.is_sandbox === true,
      hasOriginalTxn: !!sub?.original_transaction_id,
    });
    if (!knownProductIds.has(base)) continue;
    if (!sub || !sub.original_transaction_id) continue;

    const environment = sub.is_sandbox ? 'SANDBOX' : 'PRODUCTION';
    // TEMP DIAGNOSTIC (remove after root-cause): the sandbox allowlist decision
    // for this exact call — proves whether the tester UUID is being recognized.
    safeLog('subscription/sync', 'SYNC_DIAG_policy', 200, {
      user: userId.slice(0, 8) + '…',
      environment,
      isSandboxTestUser: isSandboxTestUser(userId),
      isSandboxBlockedHere: isSandboxBlockedHere(environment, userId),
    });

    // A generic "this is the subscriber's current known state" signal —
    // never a fabricated cancellation/renewal event name. RENEWAL is safe
    // here specifically because syncSubscriptionFromEvent only branches on
    // event.type for CANCELLATION/UNCANCELLATION (cancelled_at handling);
    // every other type, including this synthetic one, reconciles purely
    // from the data fields (starts_at/ends_at/product), which is exactly
    // what a subscriber snapshot actually is. The full store product id
    // (with any ':basePlanId') and the SANDBOX/PRODUCTION environment are
    // forwarded unchanged into syncSubscriptionFromEvent — the same
    // centralized place (isSandboxBlockedHere + the allowlist) the webhook
    // path also funnels through, so the two can never diverge.
    const event: RevenueCatLifecycleEvent = {
      type: 'RENEWAL',
      appUserId: userId,
      environment,
      productId: storeProductId,
      purchasedAtMs: sub.purchase_date ? new Date(sub.purchase_date).getTime() : null,
      expirationAtMs: sub.expires_date ? new Date(sub.expires_date).getTime() : null,
      originalTransactionId: sub.original_transaction_id,
      transferredTo: null,
    };
    try {
      const outcome = await syncSubscriptionFromEvent(event, { supabase });
      // TEMP DIAGNOSTIC (remove after root-cause): the actual sync outcome
      // (upserted_assignment vs sandbox_blocked_in_production vs unknown_product).
      safeLog('subscription/sync', 'SYNC_DIAG_outcome', 200, {
        user: userId.slice(0, 8) + '…',
        baseProductId: base,
        outcome: JSON.stringify(outcome),
      });
    } catch (err) {
      safeLog('subscription/sync', 'reconcile_failed', 500, { productId: base });
      // TEMP DIAGNOSTIC (remove after root-cause): sync threw.
      safeLog('subscription/sync', 'SYNC_DIAG_outcome', 500, {
        user: userId.slice(0, 8) + '…',
        baseProductId: base,
        outcome: 'threw:' + (err instanceof Error ? err.message : 'unknown'),
      });
    }
  }
}

export async function handleSubscriptionSyncRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  if (!await applyRateLimit(res, userId, 'subscription-sync')) return;

  await reconcileFromRevenueCat(userId);

  try {
    const snapshot = await resolveSubscriptionStatus(userId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(snapshot);
  } catch {
    safeLog('subscription/sync', 'status_resolve_failed', 500);
    jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível sincronizar sua assinatura agora. Tente novamente.');
  }
}
