import type { SupabaseClient } from '@supabase/supabase-js';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from './listening-execution-types';

export async function createOrGetListeningProgress(
  serviceClient: SupabaseClient,
  userId: string,
  episodeId: string,
): Promise<{ status: string; block1CompletedAt: string | null; block2CompletedAt: string | null; completedAt: string | null }> {
  // Upsert to ensure the progress row exists, then return it.
  await serviceClient
    .from('user_listening_progress')
    .upsert(
      { user_id: userId, episode_id: episodeId },
      { onConflict: 'user_id,episode_id', ignoreDuplicates: true },
    );

  const { data, error } = await serviceClient
    .from('user_listening_progress')
    .select('status, block_1_completed_at, block_2_completed_at, completed_at')
    .eq('user_id', userId)
    .eq('episode_id', episodeId)
    .single();

  if (error || !data) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.PROGRESS_SAVE_FAILED,
      'Falha ao criar ou carregar progresso do episódio.',
    );
  }

  return {
    status: data.status,
    block1CompletedAt: data.block_1_completed_at ?? null,
    block2CompletedAt: data.block_2_completed_at ?? null,
    completedAt: data.completed_at ?? null,
  };
}
