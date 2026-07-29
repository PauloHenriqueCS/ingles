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

export async function handleSubscriptionStatusRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const snapshot = await resolveSubscriptionStatus(auth.userId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(snapshot);
  } catch {
    safeLog('subscription/status', 'error', 500);
    jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar o status da assinatura. Tente novamente.');
  }
}
