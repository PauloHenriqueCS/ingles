import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ListeningExecutionError,
  LISTENING_EXECUTION_ERRORS,
  type ListeningBlockSession,
} from './listening-execution-types';

/**
 * Transitions a session from active|replay_required → awaiting_answer.
 * Called when the user finishes playing the audio for this attempt.
 */
export async function markListeningPlaybackCompleted(
  serviceClient: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<ListeningBlockSession> {
  const { data: session, error: fetchError } = await serviceClient
    .from('user_listening_block_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchError || !session) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND,
      'Sessão não encontrada.',
    );
  }

  if (new Date(session.expires_at) <= new Date()) {
    await serviceClient
      .from('user_listening_block_sessions')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', sessionId);
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED,
      'Sessão expirada.',
    );
  }

  if (session.status !== 'active' && session.status !== 'replay_required') {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE,
      `Sessão em estado inválido para esta operação: ${session.status}.`,
    );
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await serviceClient
    .from('user_listening_block_sessions')
    .update({ status: 'awaiting_answer', updated_at: now })
    .eq('id', sessionId)
    .select('*')
    .single();

  if (updateError || !updated) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.INTERNAL_ERROR,
      'Falha ao atualizar sessão.',
    );
  }

  return {
    id: updated.id,
    userId: updated.user_id,
    episodeId: updated.episode_id,
    blockId: updated.block_id,
    questionId: updated.question_id,
    attemptCycle: updated.attempt_cycle,
    currentAttempt: updated.current_attempt as 1 | 2 | 3,
    status: updated.status,
    startedAt: updated.started_at,
    expiresAt: updated.expires_at,
    completedAt: updated.completed_at ?? null,
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  };
}
