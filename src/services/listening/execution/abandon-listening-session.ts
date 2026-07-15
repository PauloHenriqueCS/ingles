import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ListeningExecutionError,
  LISTENING_EXECUTION_ERRORS,
} from './listening-execution-types';

/**
 * Marks a session as abandoned.
 * Called when the user explicitly exits, or when all 3 attempts are exhausted.
 */
export async function abandonListeningSession(
  serviceClient: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<void> {
  const { data: session, error: fetchError } = await serviceClient
    .from('user_listening_block_sessions')
    .select('id, user_id, status')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchError || !session) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND,
      'Sessão não encontrada.',
    );
  }

  if (session.status === 'completed' || session.status === 'abandoned') {
    return;
  }

  await serviceClient
    .from('user_listening_block_sessions')
    .update({ status: 'abandoned', updated_at: new Date().toISOString() })
    .eq('id', sessionId);
}
