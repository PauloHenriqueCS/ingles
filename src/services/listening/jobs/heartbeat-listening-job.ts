import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningJobType } from './listening-job-types';
import { LOCK_TIMEOUT_MS } from './listening-job-config';

export async function heartbeatListeningJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  jobType: ListeningJobType,
): Promise<boolean> {
  const extensionMs = LOCK_TIMEOUT_MS[jobType];

  const { data, error } = await supabase.rpc('heartbeat_listening_job', {
    p_job_id:       jobId,
    p_worker_id:    workerId,
    p_extension_ms: extensionMs,
  });

  if (error) {
    console.error(JSON.stringify({
      event:    'listening_job_heartbeat_error',
      jobId,
      workerId,
      error:    error.message,
      t: Date.now(),
    }));
    return false;
  }

  const extended = data === true;

  console.error(JSON.stringify({
    event:    'listening_job_heartbeat',
    jobId,
    workerId,
    extended,
    t: Date.now(),
  }));

  return extended;
}
