import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningJob, ListeningJobType } from './listening-job-types';
import { LOCK_TIMEOUT_MS } from './listening-job-config';

export async function claimNextListeningJob(
  supabase: SupabaseClient,
  workerId: string,
  supportedJobTypes: ListeningJobType[],
): Promise<ListeningJob | null> {
  if (supportedJobTypes.length === 0) return null;

  // Use the maximum lock timeout among supported types for the claim call.
  // The actual per-job timeout is enforced by the handler via heartbeat.
  const lockMs = Math.max(...supportedJobTypes.map(t => LOCK_TIMEOUT_MS[t]));

  const { data, error } = await supabase.rpc('claim_next_listening_job', {
    p_worker_id: workerId,
    p_job_types: supportedJobTypes,
    p_lock_ms:   lockMs,
  });

  if (error) throw new Error(`Failed to claim listening job: ${error.message}`);
  if (!data || data.length === 0) return null;

  const job = data[0] as ListeningJob;

  console.error(JSON.stringify({
    event:    'listening_job_claimed',
    jobId:    job.id,
    jobType:  job.job_type,
    episodeId: job.episode_id,
    attempt:  job.attempts,
    workerId,
    t: Date.now(),
  }));

  return job;
}
