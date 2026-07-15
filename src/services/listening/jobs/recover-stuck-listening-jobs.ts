import type { SupabaseClient } from '@supabase/supabase-js';

export type RecoverStuckJobsResult = {
  recoveredCount: number;
  jobIds:         string[];
};

export async function recoverStuckListeningJobs(
  supabase: SupabaseClient,
): Promise<RecoverStuckJobsResult> {
  const now = new Date().toISOString();

  const { data: stuckJobs } = await supabase
    .from('listening_jobs')
    .select('id, attempts, max_attempts, job_type')
    .eq('status', 'processing')
    .lt('lock_expires_at', now);

  if (!stuckJobs || stuckJobs.length === 0) {
    return { recoveredCount: 0, jobIds: [] };
  }

  const recoveredIds: string[] = [];

  for (const job of stuckJobs) {
    const isLastAttempt = job.attempts >= job.max_attempts;
    const newStatus = isLastAttempt ? 'dead_letter' : 'retry';
    const delayMs = isLastAttempt ? 0 : 60_000;

    const { error } = await supabase
      .from('listening_jobs')
      .update({
        status:          newStatus,
        locked_by:       null,
        locked_at:       null,
        lock_expires_at: null,
        next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
        error_code:      'LOCK_EXPIRED',
        error_message:   `Lock expired after ${job.attempts} attempt(s)`,
        finished_at:     isLastAttempt ? new Date().toISOString() : null,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'processing')
      .lt('lock_expires_at', now); // re-check to avoid race with heartbeat

    if (!error) recoveredIds.push(job.id);
  }

  if (recoveredIds.length > 0) {
    console.error(JSON.stringify({
      event:         'listening_stuck_job_recovered',
      count:         recoveredIds.length,
      jobIds:        recoveredIds,
      t: Date.now(),
    }));
  }

  return { recoveredCount: recoveredIds.length, jobIds: recoveredIds };
}
