import type { SupabaseClient } from '@supabase/supabase-js';
import type { GroupGenerationStatusResult, GroupGenerationStatus } from './listening-group-generation-types';
import {
  STEP_LABELS, STEP_PROGRESS,
  GroupJobNotFoundError, toPublicGroupJobResult,
} from './listening-group-generation-types';

const JOB_STATUS_COLUMNS = 'id, level_group, target_level, status, current_step, progress_percent, episode_id, attempts, max_attempts, error_code, error_message, retryable';

/**
 * Retries a failed shared listening_generation_jobs row — the group-job
 * counterpart of on-demand/retry-listening-generation.ts. Resets the job
 * back to the step it failed at (so the next process-next call re-runs that
 * step's idempotent handler) without creating a new job or a new episode.
 *
 * `retryable` was already computed by processListeningGroupGenerationStep at
 * failure time (false once attempts reaches max_attempts) — this function
 * only re-checks it, it never overrides it.
 */
export async function retryListeningGroupGeneration(
  jobId: string,
  serviceClient: SupabaseClient,
): Promise<GroupGenerationStatusResult> {
  const { data: job, error } = await serviceClient
    .from('listening_generation_jobs')
    .select(JOB_STATUS_COLUMNS)
    .eq('id', jobId)
    .maybeSingle();

  if (error || !job) throw new GroupJobNotFoundError(jobId);

  const typedJob = job as {
    id: string;
    level_group: string;
    target_level: string;
    status: GroupGenerationStatus;
    current_step: string | null;
    progress_percent: number;
    episode_id: string | null;
    attempts: number;
    max_attempts: number;
    error_code: string | null;
    error_message: string | null;
    retryable: boolean;
  };

  if (typedJob.status !== 'failed') {
    return toPublicGroupJobResult(typedJob);
  }

  if (!typedJob.retryable) {
    return toPublicGroupJobResult(typedJob);
  }

  // Determine the step to retry by matching current_step back to its status key.
  let retryStatus: GroupGenerationStatus = 'generating_block_1';
  for (const [status, label] of Object.entries(STEP_LABELS)) {
    if (label === typedJob.current_step) {
      retryStatus = status as GroupGenerationStatus;
      break;
    }
  }

  const now = new Date().toISOString();
  const { data: updated } = await serviceClient
    .from('listening_generation_jobs')
    .update({
      status: retryStatus,
      current_step: STEP_LABELS[retryStatus],
      progress_percent: STEP_PROGRESS[retryStatus],
      error_code: null,
      error_message: null,
      retryable: false,
      locked_by: null,
      locked_at: null,
      lock_expires_at: null,
      updated_at: now,
    })
    .eq('id', jobId)
    .eq('status', 'failed') // only if still failed (prevent race conditions)
    .select(JOB_STATUS_COLUMNS)
    .maybeSingle();

  if (updated) return toPublicGroupJobResult(updated as any);

  // If the update didn't match (concurrent retry), return current state.
  const { data: current } = await serviceClient
    .from('listening_generation_jobs')
    .select(JOB_STATUS_COLUMNS)
    .eq('id', jobId)
    .single();

  return toPublicGroupJobResult((current ?? typedJob) as any);
}
