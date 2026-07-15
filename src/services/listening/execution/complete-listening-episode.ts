import type { SupabaseClient } from '@supabase/supabase-js';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from './listening-execution-types';

/**
 * Records block 2 completion and marks the episode as completed.
 * Only called after a correct answer on block 2.
 * Requires block 1 to already be completed (enforced by DB constraint).
 */
export async function completeListeningEpisode(
  serviceClient: SupabaseClient,
  userId: string,
  episodeId: string,
  correctAttempt: 1 | 2 | 3,
): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await serviceClient
    .from('user_listening_progress')
    .update({
      status: 'completed',
      block_2_completed_at: now,
      block_2_correct_attempt: correctAttempt,
      completed_at: now,
      updated_at: now,
    })
    .eq('user_id', userId)
    .eq('episode_id', episodeId);

  if (error) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.PROGRESS_SAVE_FAILED,
      'Falha ao salvar conclusão do episódio.',
    );
  }
}
