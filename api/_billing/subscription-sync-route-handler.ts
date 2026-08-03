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
import { syncSubscriptionFromEvent, type RevenueCatLifecycleEvent } from './revenuecat-subscription-sync-service';

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

  for (const productId of KNOWN_SUBSCRIPTION_PRODUCT_IDS) {
    const sub = subscriptions[productId];
    if (!sub || !sub.original_transaction_id) continue;

    // A generic "this is the subscriber's current known state" signal —
    // never a fabricated cancellation/renewal event name. RENEWAL is safe
    // here specifically because syncSubscriptionFromEvent only branches on
    // event.type for CANCELLATION/UNCANCELLATION (cancelled_at handling);
    // every other type, including this synthetic one, reconciles purely
    // from the data fields (starts_at/ends_at/product), which is exactly
    // what a subscriber snapshot actually is.
    const event: RevenueCatLifecycleEvent = {
      type: 'RENEWAL',
      appUserId: userId,
      environment: sub.is_sandbox ? 'SANDBOX' : 'PRODUCTION',
      productId,
      purchasedAtMs: sub.purchase_date ? new Date(sub.purchase_date).getTime() : null,
      expirationAtMs: sub.expires_date ? new Date(sub.expires_date).getTime() : null,
      originalTransactionId: sub.original_transaction_id,
      transferredTo: null,
    };
    try {
      await syncSubscriptionFromEvent(event, { supabase });
    } catch {
      safeLog('subscription/sync', 'reconcile_failed', 500, { productId });
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
