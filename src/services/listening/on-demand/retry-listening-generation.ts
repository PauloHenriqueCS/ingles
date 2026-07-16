import type { SupabaseClient } from '@supabase/supabase-js';
import type { GenerationStatusResult, GenerationSessionStatus } from './listening-on-demand-types';
import {
  STEP_LABELS, STEP_PROGRESS,
  OnDemandSessionNotFoundError, toPublicSessionResult,
} from './listening-on-demand-types';

export async function retryListeningGeneration(
  sessionId: string,
  userId: string,
  serviceClient: SupabaseClient,
): Promise<GenerationStatusResult> {
  const { data: session, error } = await serviceClient
    .from('user_listening_generation_sessions')
    .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !session) throw new OnDemandSessionNotFoundError(sessionId);

  const typedSession = session as {
    id: string;
    status: GenerationSessionStatus;
    current_step: string | null;
    progress_percent: number;
    episode_id: string | null;
    error_code: string | null;
    error_message: string | null;
    retryable: boolean;
  };

  if (typedSession.status !== 'failed') {
    return toPublicSessionResult(typedSession);
  }

  if (!typedSession.retryable) {
    return toPublicSessionResult(typedSession);
  }

  // Determine the step to retry (look at current_step label to find the status)
  // Find the status that matches the current_step label
  let retryStatus: GenerationSessionStatus = 'identifying_level';
  for (const [status, label] of Object.entries(STEP_LABELS)) {
    if (label === typedSession.current_step) {
      retryStatus = status as GenerationSessionStatus;
      break;
    }
  }

  // Reset to that step (do not go back before it)
  const now = new Date().toISOString();
  const { data: updated } = await serviceClient
    .from('user_listening_generation_sessions')
    .update({
      status: retryStatus,
      current_step: STEP_LABELS[retryStatus],
      progress_percent: STEP_PROGRESS[retryStatus],
      error_code: null,
      error_message: null,
      retryable: false,
      locked_at: null,
      lock_expires_at: null,
      updated_at: now,
    })
    .eq('id', sessionId)
    .eq('status', 'failed') // only if still failed (prevent race conditions)
    .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
    .maybeSingle();

  if (updated) return toPublicSessionResult(updated as any);

  // If update didn't match (concurrent retry), return current state
  const { data: current } = await serviceClient
    .from('user_listening_generation_sessions')
    .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
    .eq('id', sessionId)
    .single();

  return toPublicSessionResult((current ?? typedSession) as any);
}
