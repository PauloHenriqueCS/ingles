import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ListeningExecutionError,
  LISTENING_EXECUTION_ERRORS,
  type EpisodeSessionResponse,
  type SessionBlockInfo,
  type PublicSubtitleCue,
} from './listening-execution-types';
import { getListeningServiceClient } from '../publication/_supabase';
import { createOrGetListeningProgress } from './create-listening-progress';
import { getOrCreateListeningSession } from './get-or-create-listening-session';
import { createListeningAudioSignedUrl } from '../publication/create-listening-signed-url';

const SUBTITLE_MODE_BY_ATTEMPT: Record<1 | 2 | 3, 'none' | 'en' | 'pt-BR'> = {
  1: 'none',
  2: 'en',
  3: 'pt-BR',
};

function toPublicCue(row: {
  id: string;
  cue_order: number;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
  sentence_key: string | null;
}): PublicSubtitleCue | null {
  if (row.start_ms == null || row.end_ms == null) return null;
  return {
    cueKey: row.sentence_key ?? row.id,
    cueOrder: row.cue_order,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
  };
}

/**
 * Builds the full episode session response for GET /api/listening/episode-session.
 *
 * - Creates/gets user progress row.
 * - For each block, determines if locked or completed.
 * - For unlocked, incomplete blocks, creates/gets an active session.
 * - Attaches audio URL (signed), question (public), and subtitles.
 * - Block 2 is locked until block 1 is completed.
 */
export async function buildListeningEpisodeSession(
  episodeId: string,
  userId: string,
  authedSupabase: SupabaseClient,
): Promise<EpisodeSessionResponse> {
  const serviceClient = getListeningServiceClient();

  // ── Verify episode is published ────────────────────────────────────────────
  const { data: episode, error: epError } = await authedSupabase
    .from('listening_episodes')
    .select('id, title, cefr_level, estimated_duration_seconds, actual_duration_seconds, status')
    .eq('id', episodeId)
    .eq('status', 'published')
    .maybeSingle();

  if (epError || !episode) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.EPISODE_NOT_FOUND,
      'Episódio publicado não encontrado.',
    );
  }

  // ── Load blocks ────────────────────────────────────────────────────────────
  const { data: blocks, error: blError } = await authedSupabase
    .from('listening_blocks')
    .select('id, block_order, duration_ms')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (blError || !blocks || blocks.length !== 2) {
    throw new ListeningExecutionError(
      LISTENING_EXECUTION_ERRORS.EPISODE_NOT_FOUND,
      'Estrutura de blocos inválida.',
    );
  }

  // ── Ensure progress row exists and load it ─────────────────────────────────
  const progress = await createOrGetListeningProgress(serviceClient, userId, episodeId);

  // ── Load questions via service role (contains correct_option — must stay server-side) ──
  const { data: questions } = await serviceClient
    .from('listening_questions')
    .select('id, block_id, question_order, prompt, options_json, max_attempts')
    .eq('episode_id', episodeId);

  // ── Load subtitles ─────────────────────────────────────────────────────────
  const blockIds = blocks.map((b) => b.id);
  const { data: cues } = await authedSupabase
    .from('listening_subtitle_cues')
    .select('id, block_id, language, cue_order, start_ms, end_ms, text, sentence_key')
    .in('block_id', blockIds)
    .order('cue_order');

  // ── Assemble blocks ────────────────────────────────────────────────────────
  const sessionBlocks: SessionBlockInfo[] = [];

  for (const block of blocks as { id: string; block_order: 1 | 2; duration_ms: number | null }[]) {
    const blockOrder = block.block_order;
    const blockQ = questions?.find((q) => q.block_id === block.id) ?? null;
    const blockCues = cues?.filter((c) => c.block_id === block.id) ?? [];
    const enCues = blockCues.filter((c) => c.language === 'en').flatMap((c) => {
      const p = toPublicCue(c); return p ? [p] : [];
    });
    const ptCues = blockCues.filter((c) => c.language === 'pt-BR').flatMap((c) => {
      const p = toPublicCue(c); return p ? [p] : [];
    });

    const subtitles = enCues.length > 0 || ptCues.length > 0
      ? { en: enCues, ptBr: ptCues }
      : null;

    // Block 2 is locked until block 1 is completed.
    const locked = blockOrder === 2 && progress.block1CompletedAt === null;

    // Block is completed if progress has recorded it.
    const completed = blockOrder === 1
      ? progress.block1CompletedAt !== null
      : progress.block2CompletedAt !== null;

    if (locked || completed) {
      sessionBlocks.push({
        blockId: block.id,
        blockOrder,
        locked,
        completed,
        durationMs: block.duration_ms ?? 0,
        session: null,
        audio: null,
        question: blockQ
          ? {
              id: blockQ.id,
              prompt: blockQ.prompt,
              options: Array.isArray(blockQ.options_json) ? blockQ.options_json as string[] : [],
              maxAttempts: 3,
            }
          : null,
        subtitles,
      });
      continue;
    }

    // ── Get/create session for this block ──────────────────────────────────
    if (!blockQ) {
      throw new ListeningExecutionError(
        LISTENING_EXECUTION_ERRORS.QUESTION_NOT_FOUND,
        `Pergunta não encontrada para o bloco ${blockOrder}.`,
      );
    }

    const session = await getOrCreateListeningSession(serviceClient, {
      userId,
      episodeId,
      blockId: block.id,
      questionId: blockQ.id,
    });

    const currentAttempt = session.currentAttempt;

    // ── Generate signed audio URL ──────────────────────────────────────────
    let audio = null;
    try {
      const signed = await createListeningAudioSignedUrl(
        { userId, episodeId, blockId: block.id },
        authedSupabase,
      );
      audio = { url: signed.url, expiresAt: signed.expiresAt, durationMs: signed.durationMs };
    } catch {
      // Audio URL failure doesn't block session creation.
    }

    sessionBlocks.push({
      blockId: block.id,
      blockOrder,
      locked: false,
      completed: false,
      durationMs: block.duration_ms ?? 0,
      session: {
        sessionId: session.id,
        attemptCycle: session.attemptCycle,
        currentAttempt,
        subtitleMode: SUBTITLE_MODE_BY_ATTEMPT[currentAttempt],
        status: session.status,
        expiresAt: session.expiresAt,
      },
      audio,
      question: {
        id: blockQ.id,
        prompt: blockQ.prompt,
        options: Array.isArray(blockQ.options_json) ? blockQ.options_json as string[] : [],
        maxAttempts: 3,
      },
      subtitles,
    });
  }

  return {
    episodeId: episode.id,
    title: episode.title,
    cefrLevel: episode.cefr_level,
    estimatedDurationSeconds: episode.estimated_duration_seconds ?? 0,
    actualDurationSeconds: episode.actual_duration_seconds ?? null,
    progress,
    blocks: sessionBlocks as [SessionBlockInfo, SessionBlockInfo],
  };
}
