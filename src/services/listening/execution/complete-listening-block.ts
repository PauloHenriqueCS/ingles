import type { SupabaseClient } from '@supabase/supabase-js';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from './listening-execution-types';

/**
 * Records block 1 completion on the user's progress row.
 * Only called after a correct answer on block 1.
 * Unlocks block 2.
 */
export async function completeListeningBlock1(
  serviceClient: SupabaseClient,
  userId: string,
  episodeId: string,
  correctAttempt: 1 | 2 | 3,
): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await serviceClient
    .from('user_listening_progress')
    .update({
      status: 'block_1_completed',
      current_block: 2,
      block_1_completed_at: now,
      block_1_correct_attempt: correctAttempt,
      updated_at: now,
    })
    .eq('user_id', userId)
    .eq('episode_id', episodeId);

  if (error) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.PROGRESS_SAVE_FAILED,
      'Falha ao salvar conclusão do Bloco 1.',
    );
  }
}
