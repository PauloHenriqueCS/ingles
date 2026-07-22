import type { SupabaseClient } from '@supabase/supabase-js';
import { NON_BLOCKING_STATUSES } from './listening-group-generation-types';

export type RecoverStuckGroupJobsResult = {
  recoveredCount: number;
  jobIds: string[];
};

/**
 * Recovers listening_generation_jobs rows whose per-step lock
 * (locked_at/lock_expires_at, set by processListeningGroupGenerationStep's
 * acquireLock) expired while the job was still in a non-terminal status —
 * e.g. a worker crashed or timed out mid-step. Mirrors
 * jobs/recover-stuck-listening-jobs.ts, adapted to this table's state
 * machine: there is no 'retry' status here, so a recovered job lands in
 * 'failed' with retryable set (unless attempts are exhausted), leaving
 * current_step untouched so retryListeningGroupGeneration resumes at the
 * exact step it was stuck in instead of restarting the whole pipeline.
 */
export async function recoverStuckListeningGroupJobs(
  supabase: SupabaseClient,
): Promise<RecoverStuckGroupJobsResult> {
  const now = new Date().toISOString();
  const nonBlockingList = [...NON_BLOCKING_STATUSES].map(s => `"${s}"`).join(',');

  const { data: stuckJobs } = await supabase
    .from('listening_generation_jobs')
    .select('id, status, attempts, max_attempts')
    .not('status', 'in', `(${nonBlockingList})`)
    .not('lock_expires_at', 'is', null)
    .lt('lock_expires_at', now);

  if (!stuckJobs || stuckJobs.length === 0) {
    return { recoveredCount: 0, jobIds: [] };
  }

  const recoveredIds: string[] = [];

  for (const job of stuckJobs as Array<{ id: string; status: string; attempts: number; max_attempts: number }>) {
    const attemptsAfter = job.attempts + 1;
    const isLastAttempt = attemptsAfter >= job.max_attempts;

    const { error } = await supabase
      .from('listening_generation_jobs')
      .update({
        status: 'failed',
        attempts: attemptsAfter,
        retryable: !isLastAttempt,
        error_code: 'LOCK_EXPIRED',
        error_message: `Lock expired while in status '${job.status}' after ${job.attempts} attempt(s)`,
        locked_by: null,
        locked_at: null,
        lock_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .lt('lock_expires_at', now) // re-check to avoid a race with a step completing concurrently
      .select('id')
      .maybeSingle();

    if (!error) recoveredIds.push(job.id);
  }

  if (recoveredIds.length > 0) {
    console.error(JSON.stringify({
      event: 'listening_group_generation_stuck_job_recovered',
      count: recoveredIds.length,
      jobIds: recoveredIds,
      t: Date.now(),
    }));
  }

  return { recoveredCount: recoveredIds.length, jobIds: recoveredIds };
}
