/**
 * Handler for POST /api/account/deactivate — self-service "Excluir minha
 * conta". Lives here (not as its own file under api/account/) and is
 * reached via a vercel.json rewrite into api/grammar-explanation.ts, purely
 * to stay within the Vercel Hobby plan's 12-serverless-function cap without
 * merging this route's *behavior* into an unrelated one — grammar-
 * explanation's own logic and URL are completely unaffected; see the branch
 * at the top of that file and the rewrite in vercel.json. If the project
 * ever moves off the Hobby plan, this can become its own api/account/
 * route file again with no logic changes.
 *
 * Identifies the user exclusively from their session (requireAuth); a
 * user_id/email/phone in the request body, if present, is never read. Never
 * deletes any data, never removes the user from Supabase Auth, never calls
 * auth.admin.deleteUser. See api/_account/deactivate-account.ts for the
 * full ordered flow (billing block → communication blocks → deactivation
 * row → session revocation) and the migrations under supabase/migrations
 * for the tables it writes to.
 */

import { randomUUID } from 'node:crypto';
import { requireAuth } from '../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog, PAYLOAD_LIMITS } from '../_helpers';
import { applyRateLimit } from '../_rateLimit';
import { deactivateAccount } from './deactivate-account';
import { recordAccountAuditEvent } from './audit';

export async function handleAccountDeactivateRoute(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.ACCOUNT_ACTION)) return;

  // allowDeactivated: this route must stay reachable — and idempotent —
  // even after the account is already deactivated (a retried request, or a
  // client that didn't see the first success).
  const auth = await requireAuth(req, res, { allowDeactivated: true });
  if (!auth) return;
  const { userId, accessToken } = auth;

  if (!await applyRateLimit(res, userId, 'account-deactivate')) return;

  const correlationId = randomUUID();

  try {
    const result = await deactivateAccount({ userId, accessToken, correlationId });
    safeLog('account-deactivate', 'success', 200, { alreadyDeactivated: result.alreadyDeactivated });
    res.json({ success: true, status: result.status });
  } catch {
    await recordAccountAuditEvent({
      userId,
      action: 'account.deactivated',
      result: 'failure',
      errorCode: 'DEACTIVATION_FAILED',
      correlationId,
    });
    safeLog('account-deactivate', 'error', 500);
    jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível concluir a exclusão da conta. Tente novamente.');
  }
}
