/**
 * GET /api/internal/listening/audit
 *
 * Cron endpoint — fires once daily (07:00 UTC = 04:00 São Paulo).
 * Runs inventory quality audit and creates operational alerts for issues found.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../_auth';
import { methodGuard, safeLog } from '../../_helpers';
import { getJobsServiceClient } from '../../../src/services/listening/jobs/_supabase';
import { auditListeningInventory } from '../../../src/services/listening/inventory/audit-listening-inventory';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  if (!checkCronAuth(req)) {
    safeLog('internal/listening/audit', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = getJobsServiceClient();
    const result = await auditListeningInventory(supabase);

    safeLog('internal/listening/audit', 'audit_completed', 200, {
      alertsCreated: result.alertsCreated,
      issues:        result.issues.length,
    });

    return res.status(200).json({
      alertsCreated: result.alertsCreated,
      issueCount:    result.issues.length,
      issues:        result.issues.slice(0, 20), // cap to avoid large responses
    });
  } catch (err) {
    safeLog('internal/listening/audit', 'audit_error', 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Audit error' });
  }
}
