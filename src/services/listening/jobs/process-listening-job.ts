import type { SupabaseClient } from '@supabase/supabase-js';
import { claimNextListeningJob } from './claim-listening-job';
import { completeListeningJob } from './complete-listening-job';
import { failListeningJob } from './fail-listening-job';
import { heartbeatListeningJob } from './heartbeat-listening-job';
import { listeningJobHandlers } from './listening-job-handlers';
import { advanceListeningPipeline } from '../pipeline/advance-listening-pipeline';
import { HEARTBEAT_INTERVAL_MS } from './listening-job-config';
import { LISTENING_JOB_TYPES, ListeningJobError } from './listening-job-types';
import type { ListeningJobType } from './listening-job-types';

export type ProcessListeningJobResult = {
  processed:   boolean;
  jobId?:      string;
  jobType?:    string;
  success?:    boolean;
  durationMs?: number;
};

const ALL_JOB_TYPES = Object.values(LISTENING_JOB_TYPES) as ListeningJobType[];

export async function processNextListeningJob(
  supabase: SupabaseClient,
  workerId: string,
  supportedJobTypes: ListeningJobType[] = ALL_JOB_TYPES,
): Promise<ProcessListeningJobResult> {
  const job = await claimNextListeningJob(supabase, workerId, supportedJobTypes);
  if (!job) return { processed: false };

  const startMs = Date.now();

  console.error(JSON.stringify({
    event:     'listening_job_started',
    jobId:     job.id,
    jobType:   job.job_type,
    episodeId: job.episode_id,
    attempt:   job.attempts,
    workerId,
    t: startMs,
  }));

  // Set up heartbeat — runs every minute to extend the lock
  const heartbeatFn = () => heartbeatListeningJob(supabase, job.id, workerId, job.job_type);
  const heartbeatTimer = setInterval(() => { heartbeatFn().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);

  try {
    const handler = listeningJobHandlers[job.job_type];
    if (!handler) {
      throw new ListeningJobError('NO_HANDLER', `No handler registered for job type: ${job.job_type}`, false);
    }

    const result = await handler({ job, workerId, heartbeat: heartbeatFn });

    clearInterval(heartbeatTimer);

    await completeListeningJob(supabase, job.id, workerId, result);

    // Advance the pipeline — create next job(s)
    try {
      await advanceListeningPipeline(supabase, { ...job, result });
    } catch (pipelineErr) {
      console.error(JSON.stringify({
        event:   'listening_pipeline_advance_error',
        jobId:   job.id,
        jobType: job.job_type,
        error:   String(pipelineErr),
        t: Date.now(),
      }));
    }

    const durationMs = Date.now() - startMs;
    console.error(JSON.stringify({
      event:     'listening_job_completed',
      jobId:     job.id,
      jobType:   job.job_type,
      episodeId: job.episode_id,
      durationMs,
      t: Date.now(),
    }));

    return { processed: true, jobId: job.id, jobType: job.job_type, success: true, durationMs };

  } catch (err: unknown) {
    clearInterval(heartbeatTimer);

    const isJobError  = err instanceof ListeningJobError;
    const retryable   = isJobError
      ? err.retryable
      : ((err as { retryable?: boolean }).retryable ?? true);
    const code        = (err as { code?: string }).code ?? 'UNKNOWN_ERROR';
    const message     = err instanceof Error ? err.message : String(err);

    console.error(JSON.stringify({
      event:     'listening_job_failed',
      jobId:     job.id,
      jobType:   job.job_type,
      episodeId: job.episode_id,
      errorCode: code,
      retryable,
      attempt:   job.attempts,
      t: Date.now(),
    }));

    await failListeningJob(supabase, {
      jobId:        job.id,
      workerId,
      errorCode:    code,
      errorMessage: message,
      retryable,
    });

    const durationMs = Date.now() - startMs;
    return { processed: true, jobId: job.id, jobType: job.job_type, success: false, durationMs };
  }
}
