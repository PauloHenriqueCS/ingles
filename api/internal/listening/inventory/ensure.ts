/**
 * GET /api/internal/listening/inventory/ensure
 *
 * Cron endpoint — fires once daily (06:00 UTC = 03:00 São Paulo).
 * Checks inventory levels and creates generation pipelines for levels below target.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../../_auth';
import { methodGuard, safeLog } from '../../../_helpers';
import { getJobsServiceClient } from '../../../../src/services/listening/jobs/_supabase';
import { ensureListeningInventory } from '../../../../src/services/listening/inventory/ensure-listening-inventory';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  if (!checkCronAuth(req)) {
    safeLog('internal/listening/inventory/ensure', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = getJobsServiceClient();
    const result = await ensureListeningInventory(supabase, { source: 'inventory_cron' });

    safeLog('internal/listening/inventory/ensure', 'inventory_ensure_completed', 200, {
      created: result.created,
    });

    return res.status(200).json({
      pipelinesCreated: result.created,
      levels:           result.levels,
    });
  } catch (err) {
    safeLog('internal/listening/inventory/ensure', 'inventory_ensure_error', 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Inventory ensure error' });
  }
}
