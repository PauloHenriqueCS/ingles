import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ListeningExecutionError,
  LISTENING_EXECUTION_ERRORS,
  type ListeningBlockSession,
} from './listening-execution-types';
import { LISTENING_EXECUTION_CONFIG } from './listening-execution-config';
import { expireListeningSessions } from './expire-listening-sessions';

function rowToSession(row: Record<string, unknown>): ListeningBlockSession {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    episodeId: row.episode_id as string,
    blockId: row.block_id as string,
    questionId: row.question_id as string,
    attemptCycle: row.attempt_cycle as number,
    currentAttempt: row.current_attempt as 1 | 2 | 3,
    status: row.status as ListeningBlockSession['status'],
    startedAt: row.started_at as string,
    expiresAt: row.expires_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Returns the active session for a block, or creates a new one.
 *
 * A "live" session is one with status active|awaiting_answer|replay_required.
 * If the block was already completed in progress, throws BLOCK_ALREADY_COMPLETED.
 * Determines the attempt_cycle by inspecting past sessions for this user+block.
 */
export async function getOrCreateListeningSession(
  serviceClient: SupabaseClient,
  params: {
    userId: string;
    episodeId: string;
    blockId: string;
    questionId: string;
  },
): Promise<ListeningBlockSession> {
  const { userId, episodeId, blockId, questionId } = params;

  // Expire stale sessions first.
  await expireListeningSessions(serviceClient, userId, blockId);

  // Look for an existing live session.
  const { data: existing, error: existingError } = await serviceClient
    .from('user_listening_block_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('block_id', blockId)
    .in('status', ['active', 'awaiting_answer', 'replay_required'])
    .maybeSingle();

  if (existingError) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.INTERNAL_ERROR,
      'Falha ao buscar sessão existente.',
    );
  }

  if (existing) {
    return rowToSession(existing);
  }

  // Determine the next attempt_cycle from past sessions.
  const { data: pastSessions } = await serviceClient
    .from('user_listening_block_sessions')
    .select('attempt_cycle')
    .eq('user_id', userId)
    .eq('block_id', blockId)
    .in('status', ['abandoned', 'expired', 'completed'])
    .order('attempt_cycle', { ascending: false })
    .limit(1);

  const maxCycle = pastSessions?.[0]?.attempt_cycle ?? 0;
  const newCycle = maxCycle + 1;

  const expiresAt = new Date(
    Date.now() + LISTENING_EXECUTION_CONFIG.sessionExpiresInSeconds * 1000,
  ).toISOString();

  const { data: created, error: createError } = await serviceClient
    .from('user_listening_block_sessions')
    .insert({
      user_id: userId,
      episode_id: episodeId,
      block_id: blockId,
      question_id: questionId,
      attempt_cycle: newCycle,
      current_attempt: 1,
      status: 'active',
      expires_at: expiresAt,
    })
    .select('*')
    .single();

  if (createError || !created) {
    // Unique index violation: another request created a session concurrently.
    if (createError?.code === '23505') {
      throw new ListeningExecutionError(
        LISTENING_EXECUTION_ERRORS.SESSION_CONFLICT,
        'Conflito ao criar sessão — tente novamente.',
        true,
      );
    }
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.INTERNAL_ERROR,
      'Falha ao criar sessão.',
    );
  }

  return rowToSession(created);
}
