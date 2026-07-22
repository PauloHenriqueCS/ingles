/**
 * POST /api/account/deactivate — self-service "Excluir minha conta".
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
import { deactivateAccount } from '../_account/deactivate-account';
import { recordAccountAuditEvent } from '../_account/audit';

export default async function handler(req: any, res: any) {
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
    return res.json({ success: true, status: result.status });
  } catch {
    await recordAccountAuditEvent({
      userId,
      action: 'account.deactivated',
      result: 'failure',
      errorCode: 'DEACTIVATION_FAILED',
      correlationId,
    });
    safeLog('account-deactivate', 'error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível concluir a exclusão da conta. Tente novamente.');
  }
}
