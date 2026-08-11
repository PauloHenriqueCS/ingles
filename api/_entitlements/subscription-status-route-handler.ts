/**
 * Handler for GET /api/subscription/status — self-service subscription
 * status for the /assinatura screen. Lives here (not as its own file under
 * api/subscription/) and is reached via a vercel.json rewrite into
 * api/grammar-explanation.ts, purely to stay within the Vercel Hobby plan's
 * 12-serverless-function cap — same reuse as account-deactivate and
 * config-public (see the branches at the top of that file). Grammar-
 * explanation's own logic and URL are completely unaffected.
 *
 * Identifies the user exclusively from their session (requireAuth) and
 * resolves everything server-side via resolveSubscriptionStatus — the
 * request body/query is never read for a plan or status value, so the
 * frontend cannot forge its own subscription state.
 */

import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog } from '../_helpers';
import { resolveSubscriptionStatus } from './subscription-status-service';
// TEMP DIAGNOSTIC (SYNC_DIAG_txn — remove together with the other SYNC_DIAG_*
// instrumentation when the reconcile fix lands). Read-only store_transaction_id
// stability probe for an allowlisted sandbox tester only.
import { createHash } from 'node:crypto';
import { getRevenueCatApiSecretKey } from '../_env';
import { isSandboxTestUser } from '../_billing/revenuecat-environment';

/**
 * TEMP DIAGNOSTIC — allowlisted sandbox tester ONLY. Reads RevenueCat's REST
 * subscriber and logs a short irreversible hash of each subscription's
 * store_transaction_id (plus dates), to observe whether it changes across
 * sandbox renewals. STRICTLY READ-ONLY: never writes, never calls the sync
 * service, never touches user_plan_assignments, and never changes what
 * /subscription/status returns. Best-effort — any failure is swallowed.
 */
async function diagLogStoreTxnHashes(userId: string): Promise<void> {
  if (!isSandboxTestUser(userId)) return; // never runs for a normal user
  const apiKey = getRevenueCatApiSecretKey();
  if (!apiKey) return;
  let response: Response;
  try {
    response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return;
  }
  if (!response.ok) return;
  let body: { subscriber?: { subscriptions?: Record<string, Record<string, unknown>> } };
  try {
    body = (await response.json()) as { subscriber?: { subscriptions?: Record<string, Record<string, unknown>> } };
  } catch {
    return;
  }
  const subscriptions = body.subscriber?.subscriptions ?? {};
  for (const [productId, sub] of Object.entries(subscriptions)) {
    const s = sub ?? {};
    const storeTxn = typeof s.store_transaction_id === 'string' ? s.store_transaction_id : '';
    safeLog('subscription/status', 'SYNC_DIAG_txn', 200, {
      user: userId.slice(0, 8) + '…',
      rawProductId: productId,
      store_transaction_id_hash: storeTxn ? createHash('sha256').update(storeTxn).digest('hex').slice(0, 12) : '(none)',
      purchase_date: typeof s.purchase_date === 'string' ? s.purchase_date : String(s.purchase_date ?? ''),
      expires_date: typeof s.expires_date === 'string' ? s.expires_date : String(s.expires_date ?? ''),
      is_sandbox: s.is_sandbox === true,
    });
  }
}

export async function handleSubscriptionStatusRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const snapshot = await resolveSubscriptionStatus(auth.userId);
    // TEMP DIAGNOSTIC (read-only, allowlisted sandbox tester only) — never
    // alters `snapshot` or the response below; failures are fully swallowed.
    await diagLogStoreTxnHashes(auth.userId).catch(() => {});
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(snapshot);
  } catch {
    safeLog('subscription/status', 'error', 500);
    jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar o status da assinatura. Tente novamente.');
  }
}
