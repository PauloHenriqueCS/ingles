import type { SupabaseClient } from '@supabase/supabase-js';
import { getRetryDelayMs } from './listening-job-config';

export type FailListeningJobInput = {
  jobId:        string;
  workerId:     string;
  errorCode:    string;
  errorMessage: string;
  retryable:    boolean;
};

export async function failListeningJob(
  supabase: SupabaseClient,
  input: FailListeningJobInput,
): Promise<void> {
  const { jobId, workerId, errorCode, errorMessage, retryable } = input;

  const { data: job } = await supabase
    .from('listening_jobs')
    .select('attempts, max_attempts')
    .eq('id', jobId)
    .eq('locked_by', workerId)
    .maybeSingle();

  if (!job) return; // Job was already claimed by someone else or doesn't exist

  const isLastAttempt = job.attempts >= job.max_attempts;
  const shouldRetry = retryable && !isLastAttempt;

  const now = new Date();
  let newStatus: string;
  if (isLastAttempt) {
    newStatus = 'dead_letter';
  } else if (shouldRetry) {
    newStatus = 'retry';
  } else {
    newStatus = 'failed';
  }

  const nextAttempt = shouldRetry
    ? new Date(now.getTime() + getRetryDelayMs(job.attempts))
    : now;

  const isTerminal = newStatus === 'dead_letter' || newStatus === 'failed';

  const { error } = await supabase
    .from('listening_jobs')
    .update({
      status:          newStatus,
      error_code:      errorCode,
      error_message:   errorMessage.slice(0, 500),
      locked_by:       null,
      locked_at:       null,
      lock_expires_at: null,
      next_attempt_at: nextAttempt.toISOString(),
      finished_at:     isTerminal ? now.toISOString() : null,
      updated_at:      now.toISOString(),
    })
    .eq('id', jobId)
    .eq('locked_by', workerId);

  if (error) {
    throw new Error(`Failed to mark job ${jobId} as failed: ${error.message}`);
  }

  const event = newStatus === 'dead_letter'
    ? 'listening_job_dead_letter'
    : newStatus === 'retry'
    ? 'listening_job_retry_scheduled'
    : 'listening_job_failed';

  console.error(JSON.stringify({
    event,
    jobId,
    errorCode,
    newStatus,
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
    nextAttempt: shouldRetry ? nextAttempt.toISOString() : null,
    t: Date.now(),
  }));
}
