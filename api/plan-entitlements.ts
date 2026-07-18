import { requireAuth } from './_auth';
import { methodGuard, jsonError, safeLog } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';

/**
 * GET /api/plan-entitlements — the authenticated user's resolved plan and
 * entitlements snapshot (access, limits, consumption, extra credits). The
 * plan is always resolved server-side from the authenticated user; nothing
 * in the request body/query can influence which plan is returned.
 */
export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  if (!(await applyRateLimit(res, userId, 'plan-entitlements'))) return;

  try {
    const snapshot = await getCurrentUserPlanEntitlements(userId);
    return res.json(snapshot);
  } catch (err) {
    safeLog('plan-entitlements', 'resolve_failed', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar as informações do seu plano.');
  }
}
