// GET /api/internal/product-config/status — dashboard-facing integration
// status. Reuses the api/internal/listening/[...slug].ts function slot (see
// vercel.json rewrite) purely for the Vercel Hobby plan's function budget;
// otherwise unrelated to listening. Auth is independent of that dispatcher's
// checkCronAuth — a different caller (the dashboard), a dedicated secret.

import { methodGuard, safeLog } from '../_helpers';
import { buildStatusPayload, checkProductConfigStatusAuth } from '../../src/server/product-config';

export async function handleProductConfigStatusRoute(req: any, res: any, subSlug: string): Promise<void> {
  if (!checkProductConfigStatusAuth(req)) {
    safeLog('internal/product-config', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!methodGuard(req, res, ['GET'])) return;

  if (subSlug !== 'status') {
    return res.status(404).json({ error: 'Route not found', slug: `product-config/${subSlug}` });
  }

  try {
    const payload = await buildStatusPayload();
    return res.status(200).json(payload);
  } catch (err) {
    safeLog('internal/product-config', 'status_unexpected_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to build status payload' });
  }
}
