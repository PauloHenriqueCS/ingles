/**
 * GET /api/internal/listening/repair
 *
 * Cron endpoint — fires every 10 minutes via Vercel Cron.
 * Recovers stuck jobs whose locks have expired.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../_auth';
import { methodGuard, safeLog } from '../../_helpers';
import { getJobsServiceClient } from '../../../src/services/listening/jobs/_supabase';
import { recoverStuckListeningJobs } from '../../../src/services/listening/jobs/recover-stuck-listening-jobs';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  if (!checkCronAuth(req)) {
    safeLog('internal/listening/repair', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = getJobsServiceClient();
    const result = await recoverStuckListeningJobs(supabase);

    safeLog('internal/listening/repair', 'repair_completed', 200, {
      recovered: result.recoveredCount,
    });

    return res.status(200).json({
      recovered: result.recoveredCount,
      jobIds:    result.jobIds,
    });
  } catch (err) {
    safeLog('internal/listening/repair', 'repair_error', 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Repair error' });
  }
}
