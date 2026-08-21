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
import { resolveSubscriptionStatus } from '../_entitlements/subscription-status-service';
import { reconcileSubscriptionsFromRevenueCatRest } from './revenuecat-rest-reconcile';

export async function handleSubscriptionSyncRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  if (!await applyRateLimit(res, userId, 'subscription-sync')) return;

  // Shared with the webhook's TRANSFER branch — one reconcile implementation,
  // never a second source of truth (see revenuecat-rest-reconcile.ts).
  await reconcileSubscriptionsFromRevenueCatRest(userId, 'subscription/sync');

  try {
    const snapshot = await resolveSubscriptionStatus(userId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(snapshot);
  } catch {
    safeLog('subscription/sync', 'status_resolve_failed', 500);
    jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível sincronizar sua assinatura agora. Tente novamente.');
  }
}
