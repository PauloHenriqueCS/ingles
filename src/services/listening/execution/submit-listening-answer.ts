import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ListeningExecutionError,
  LISTENING_EXECUTION_ERRORS,
  type SubmitAnswerResult,
} from './listening-execution-types';
import { LISTENING_EXECUTION_CONFIG } from './listening-execution-config';
import { completeListeningBlock1 } from './complete-listening-block';
import { completeListeningEpisode } from './complete-listening-episode';

const SUBTITLE_MODE_BY_ATTEMPT: Record<1 | 2 | 3, 'none' | 'en' | 'pt-BR'> = {
  1: 'none',
  2: 'en',
  3: 'pt-BR',
};

export type SubmitAnswerInput = {
  sessionId: string;
  userId: string;
  questionId: string;
  selectedOption: number;
  submissionId: string;
  playbackRate?: number;
};

/**
 * Validates a user's answer for a block question.
 *
 * - Correct → saves progress (block or episode completion), marks session completed.
 * - Wrong, attempt < 3 → increments attempt, sets session to replay_required.
 * - Wrong, attempt = 3 → marks session abandoned (cycle exhausted).
 * - Duplicate submissionId → returns same result without re-processing (idempotency).
 */
export async function submitListeningAnswer(
  serviceClient: SupabaseClient,
  input: SubmitAnswerInput,
): Promise<SubmitAnswerResult> {
  const { sessionId, userId, questionId, selectedOption, submissionId, playbackRate = 1.0 } = input;

  // ── Idempotency check ──────────────────────────────────────────────────────
  const { data: existing } = await serviceClient
    .from('user_listening_attempts')
    .select('is_correct, attempt_number')
    .eq('user_id', userId)
    .eq('submission_id', submissionId)
    .maybeSingle();

  if (existing) {
    // Already processed this submission — return a reconstructed result without re-processing.
    const attempt = existing.attempt_number as 1 | 2 | 3;
    const correct = existing.is_correct === true;
    const nextAttempt = correct ? null : attempt < 3 ? ((attempt + 1) as 2 | 3) : null;
    const sessionStatus = correct ? 'completed' : attempt < 3 ? 'replay_required' : 'abandoned';
    return {
      correct,
      attemptNumber: attempt,
      sessionStatus,
      nextAttempt,
      nextSubtitleMode: nextAttempt ? SUBTITLE_MODE_BY_ATTEMPT[nextAttempt] : null,
      explanationPt: null,
      correctOption: null,
      blockCompleted: correct,
      episodeCompleted: false,
    };
  }

  // ── Load and validate session ──────────────────────────────────────────────
  const { data: session, error: sessionError } = await serviceClient
    .from('user_listening_block_sessions')
    .select('id, user_id, episode_id, block_id, question_id, attempt_cycle, current_attempt, status, expires_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (sessionError || !session) {
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

  if (session.status !== 'awaiting_answer') {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE,
      `Sessão em estado inválido para submissão: ${session.status}.`,
    );
  }

  if (session.question_id !== questionId) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE,
      'questionId não corresponde à sessão.',
    );
  }

  // ── Load correct option via service role ───────────────────────────────────
  const { data: question, error: questionError } = await serviceClient
    .from('listening_questions')
    .select('id, correct_option, explanation_pt, block_id')
    .eq('id', questionId)
    .maybeSingle();

  if (questionError || !question) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.QUESTION_NOT_FOUND,
      'Pergunta não encontrada.',
    );
  }

  // ── Determine which block order (1 or 2) ──────────────────────────────────
  const { data: block } = await serviceClient
    .from('listening_blocks')
    .select('block_order')
    .eq('id', session.block_id)
    .single();

  const blockOrder = (block?.block_order ?? 1) as 1 | 2;
  const currentAttempt = session.current_attempt as 1 | 2 | 3;
  const subtitleMode = SUBTITLE_MODE_BY_ATTEMPT[currentAttempt];
  const correct = selectedOption === question.correct_option;
  const now = new Date().toISOString();

  // ── Log the attempt ────────────────────────────────────────────────────────
  const { error: insertError } = await serviceClient
    .from('user_listening_attempts')
    .insert({
      user_id: userId,
      episode_id: session.episode_id,
      block_id: session.block_id,
      question_id: questionId,
      attempt_cycle: session.attempt_cycle,
      attempt_number: currentAttempt,
      selected_option: selectedOption,
      is_correct: correct,
      subtitle_mode: subtitleMode,
      playback_rate: playbackRate,
      answered_at: now,
      submission_id: submissionId,
    })
    .select('id')
    .single();

  if (insertError) {
    // 23505 = unique_violation: duplicate (user, question, cycle, attempt)
    if ((insertError as any).code === '23505') {
      throw new ListeningExecutionError(
        LISTENING_EXECUTION_ERRORS.DUPLICATE_SUBMISSION,
        'Tentativa já registrada.',
      );
    }
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.INTERNAL_ERROR,
      'Falha ao registrar tentativa.',
    );
  }

  // ── Handle correct answer ──────────────────────────────────────────────────
  if (correct) {
    await serviceClient
      .from('user_listening_block_sessions')
      .update({ status: 'completed', completed_at: now, updated_at: now })
      .eq('id', sessionId);

    let episodeCompleted = false;
    if (blockOrder === 1) {
      await completeListeningBlock1(serviceClient, userId, session.episode_id, currentAttempt);
    } else {
      await completeListeningEpisode(serviceClient, userId, session.episode_id, currentAttempt);
      episodeCompleted = true;
    }

    return {
      correct: true,
      attemptNumber: currentAttempt,
      sessionStatus: 'completed',
      nextAttempt: null,
      nextSubtitleMode: null,
      explanationPt: question.explanation_pt,
      correctOption: null,
      blockCompleted: true,
      episodeCompleted,
    };
  }

  // ── Handle wrong answer ────────────────────────────────────────────────────
  const isLastAttempt = currentAttempt >= LISTENING_EXECUTION_CONFIG.maximumAttemptsPerCycle;

  if (isLastAttempt) {
    await serviceClient
      .from('user_listening_block_sessions')
      .update({ status: 'abandoned', updated_at: now })
      .eq('id', sessionId);

    return {
      correct: false,
      attemptNumber: currentAttempt,
      sessionStatus: 'abandoned',
      nextAttempt: null,
      nextSubtitleMode: null,
      explanationPt: question.explanation_pt,
      correctOption: question.correct_option,
      blockCompleted: false,
      episodeCompleted: false,
    };
  }

  const nextAttempt = (currentAttempt + 1) as 2 | 3;
  await serviceClient
    .from('user_listening_block_sessions')
    .update({
      status: 'replay_required',
      current_attempt: nextAttempt,
      updated_at: now,
    })
    .eq('id', sessionId);

  return {
    correct: false,
    attemptNumber: currentAttempt,
    sessionStatus: 'replay_required',
    nextAttempt,
    nextSubtitleMode: SUBTITLE_MODE_BY_ATTEMPT[nextAttempt],
    explanationPt: null,
    correctOption: null,
    blockCompleted: false,
    episodeCompleted: false,
  };
}
