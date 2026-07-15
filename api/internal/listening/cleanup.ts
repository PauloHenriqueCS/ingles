/**
 * GET /api/internal/listening/cleanup
 *
 * Cron endpoint — fires once weekly (09:00 UTC Sunday).
 * Cleans up completed jobs older than retention period and staging files.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../_auth';
import { methodGuard, safeLog } from '../../_helpers';
import { getJobsServiceClient } from '../../../src/services/listening/jobs/_supabase';
import { RETENTION_DAYS } from '../../../src/services/listening/jobs/listening-job-config';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  if (!checkCronAuth(req)) {
    safeLog('internal/listening/cleanup', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = getJobsServiceClient();
    let totalDeleted = 0;

    // Delete completed jobs older than 90 days
    const completedCutoff = new Date(Date.now() - RETENTION_DAYS.COMPLETED * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedCompleted } = await supabase
      .from('listening_jobs')
      .delete()
      .eq('status', 'completed')
      .lt('finished_at', completedCutoff)
      .select('id');
    totalDeleted += (deletedCompleted?.length ?? 0);

    // Delete cancelled jobs older than 90 days
    const cancelledCutoff = new Date(Date.now() - RETENTION_DAYS.CANCELLED * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedCancelled } = await supabase
      .from('listening_jobs')
      .delete()
      .eq('status', 'cancelled')
      .lt('finished_at', cancelledCutoff)
      .select('id');
    totalDeleted += (deletedCancelled?.length ?? 0);

    // Delete failed jobs older than 180 days (dead_letter kept indefinitely)
    const failedCutoff = new Date(Date.now() - RETENTION_DAYS.FAILED * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedFailed } = await supabase
      .from('listening_jobs')
      .delete()
      .eq('status', 'failed')
      .lt('finished_at', failedCutoff)
      .select('id');
    totalDeleted += (deletedFailed?.length ?? 0);

    // Cleanup resolved alerts older than 30 days
    const alertCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('listening_operational_alerts')
      .delete()
      .eq('status', 'resolved')
      .lt('resolved_at', alertCutoff);

    safeLog('internal/listening/cleanup', 'cleanup_completed', 200, {
      deleted: totalDeleted,
    });

    return res.status(200).json({ deleted: totalDeleted });

  } catch (err) {
    safeLog('internal/listening/cleanup', 'cleanup_error', 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Cleanup error' });
  }
}
