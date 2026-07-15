/**
 * GET /api/internal/listening/jobs/dispatch
 *
 * Cron endpoint — fires every minute via Vercel Cron.
 * Claims and processes up to 3 eligible jobs, respecting concurrency limits.
 * Protected by Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../../_auth';
import { methodGuard, safeLog } from '../../../_helpers';
import { getJobsServiceClient } from '../../../../src/services/listening/jobs/_supabase';
import { processNextListeningJob } from '../../../../src/services/listening/jobs/process-listening-job';
import {
  TEXT_JOB_TYPES,
  AZURE_JOB_TYPES,
  SYNC_JOB_TYPES,
  PUBLISH_JOB_TYPES,
  JOB_CONCURRENCY,
} from '../../../../src/services/listening/jobs/listening-job-config';
import type { ListeningJobType } from '../../../../src/services/listening/jobs/listening-job-types';

const BATCH_SIZE = 3;

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  if (!checkCronAuth(req)) {
    safeLog('internal/listening/jobs/dispatch', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const workerId = `vercel-cron-${Date.now()}`;
  const supabase = getJobsServiceClient();

  const processed: Array<{ jobId: string; jobType: string; success: boolean; durationMs: number }> = [];

  try {
    // Check current concurrency usage before dispatching
    const { data: activeJobs } = await supabase
      .from('listening_jobs')
      .select('job_type')
      .eq('status', 'processing');

    const activeJobTypes = (activeJobs ?? []).map((j: { job_type: string }) => j.job_type);

    const activeText    = activeJobTypes.filter((t: string) => TEXT_JOB_TYPES.includes(t as ListeningJobType)).length;
    const activeAzure   = activeJobTypes.filter((t: string) => AZURE_JOB_TYPES.includes(t as ListeningJobType)).length;
    const activeSync    = activeJobTypes.filter((t: string) => SYNC_JOB_TYPES.includes(t as ListeningJobType)).length;
    const activePublish = activeJobTypes.filter((t: string) => PUBLISH_JOB_TYPES.includes(t as ListeningJobType)).length;

    // Build list of eligible job types based on concurrency limits
    const eligibleTypes: ListeningJobType[] = [];
    if (activeText    < JOB_CONCURRENCY.maxConcurrentText)    eligibleTypes.push(...TEXT_JOB_TYPES);
    if (activeAzure   < JOB_CONCURRENCY.maxConcurrentAzure)   eligibleTypes.push(...AZURE_JOB_TYPES);
    if (activeSync    < JOB_CONCURRENCY.maxConcurrentSync)     eligibleTypes.push(...SYNC_JOB_TYPES);
    if (activePublish < JOB_CONCURRENCY.maxConcurrentPublish)  eligibleTypes.push(...PUBLISH_JOB_TYPES);

    if (eligibleTypes.length === 0) {
      safeLog('internal/listening/jobs/dispatch', 'concurrency_limit_reached', 200, {});
      return res.status(200).json({ processed: 0, reason: 'concurrency_limit_reached' });
    }

    for (let i = 0; i < BATCH_SIZE; i++) {
      const result = await processNextListeningJob(supabase, workerId, eligibleTypes);
      if (!result.processed) break;

      processed.push({
        jobId:     result.jobId!,
        jobType:   result.jobType!,
        success:   result.success ?? false,
        durationMs: result.durationMs ?? 0,
      });
    }

    safeLog('internal/listening/jobs/dispatch', 'dispatch_completed', 200, {
      processed: processed.length,
    });

    return res.status(200).json({ processed: processed.length, jobs: processed });

  } catch (err) {
    safeLog('internal/listening/jobs/dispatch', 'dispatch_error', 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: 'Dispatch error' });
  }
}
