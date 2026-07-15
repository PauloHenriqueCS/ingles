import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LISTENING_ERRORS,
  ListeningPublicationError,
  type PublicListeningEpisodeResponse,
  type PublicListeningBlock,
  type PublicListeningQuestion,
  type PublicListeningSubtitleCue,
  type PublicListeningSubtitles,
  type PublicListeningAudio,
} from './listening-publication-types';
import { createListeningAudioSignedUrl } from './create-listening-signed-url';

/**
 * Converte uma pergunta do banco para o formato público.
 * Nunca inclui: correctOption, explanationPt, evidências, status interno.
 */
export function toPublicListeningQuestion(row: {
  id: string;
  question_order: number;
  block_id: string;
  prompt: string;
  options_json: unknown;
  max_attempts: number;
}): PublicListeningQuestion {
  const options = Array.isArray(row.options_json)
    ? (row.options_json as string[])
    : [];
  return {
    id: row.id,
    questionOrder: row.question_order as 1 | 2,
    blockId: row.block_id,
    prompt: row.prompt,
    options,
    maxAttempts: 3,
  };
}

/**
 * Converte um cue de legenda para o formato público.
 * Nunca inclui: audio_hash, ssml_hash, timing_hash, source_sentence_keys, confiança.
 */
function toPublicSubtitleCue(row: {
  id: string;
  cue_order: number;
  start_ms: number;
  end_ms: number;
  text: string;
  sentence_key: string | null;
}): PublicListeningSubtitleCue {
  return {
    cueKey: row.sentence_key ?? row.id,
    cueOrder: row.cue_order,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
  };
}

/**
 * Monta o episódio público com URL assinada por bloco.
 * Dados nunca incluem: correctOption, SSML, hashes, paths internos, eventos brutos.
 * Bloco 2 retorna locked=true (desbloqueio implementado na Etapa 9 via progresso real).
 */
export async function buildPublicListeningEpisode(
  episodeId: string,
  userId: string,
  authedSupabase: SupabaseClient,
): Promise<PublicListeningEpisodeResponse> {
  // Carregar episódio
  const { data: episode, error: epError } = await authedSupabase
    .from('listening_episodes')
    .select('id, title, synopsis, cefr_level, estimated_duration_seconds, actual_duration_seconds, status')
    .eq('id', episodeId)
    .eq('status', 'published')
    .maybeSingle();

  if (epError || !episode) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.EPISODE_NOT_FOUND,
      'Episódio publicado não encontrado.',
      episodeId,
    );
  }

  // Carregar blocos
  const { data: blocks, error: blError } = await authedSupabase
    .from('listening_blocks')
    .select('id, block_order, duration_ms')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (blError || !blocks || blocks.length !== 2) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.VALIDATION_FAILED,
      'Estrutura de blocos inválida.',
      episodeId,
    );
  }

  // Carregar perguntas via view pública (sem correct_option)
  const { data: questions, error: qError } = await authedSupabase
    .from('listening_questions_public')
    .select('id, question_order, block_id, prompt, options_json, max_attempts')
    .eq('episode_id', episodeId);

  if (qError || !questions) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.QUESTION_INVALID,
      'Erro ao carregar perguntas.',
      episodeId,
    );
  }

  // Carregar legendas
  const blockIds = blocks.map((b) => b.id);
  const { data: cues, error: cueError } = await authedSupabase
    .from('listening_subtitle_cues')
    .select('id, block_id, language, cue_order, start_ms, end_ms, text, sentence_key')
    .in('block_id', blockIds)
    .order('cue_order');

  if (cueError || !cues) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.SUBTITLE_INVALID,
      'Erro ao carregar legendas.',
      episodeId,
    );
  }

  // Montar blocos públicos
  const publicBlocks: PublicListeningBlock[] = [];

  for (const block of blocks as { id: string; block_order: 1 | 2; duration_ms: number | null }[]) {
    const blockQ = questions.find((q) => q.block_id === block.id) ?? null;
    const enCues = cues
      .filter((c) => c.block_id === block.id && c.language === 'en')
      .map(toPublicSubtitleCue);
    const ptCues = cues
      .filter((c) => c.block_id === block.id && c.language === 'pt-BR')
      .map(toPublicSubtitleCue);

    let audio: PublicListeningAudio | null = null;
    try {
      const signed = await createListeningAudioSignedUrl(
        { userId, episodeId, blockId: block.id },
        authedSupabase,
      );
      audio = { url: signed.url, expiresAt: signed.expiresAt };
    } catch {
      // URL não disponível não impede retorno do episódio com metadados.
    }

    const subtitles: PublicListeningSubtitles | null =
      enCues.length > 0 || ptCues.length > 0
        ? { en: enCues, ptBr: ptCues }
        : null;

    const publicQ: PublicListeningQuestion | null = blockQ
      ? toPublicListeningQuestion(blockQ)
      : null;

    publicBlocks.push({
      id: block.id,
      blockOrder: block.block_order,
      // Bloco 2 permanece locked até o progresso real ser implementado (Etapa 9).
      locked: block.block_order === 2,
      durationMs: block.duration_ms ?? 0,
      audio,
      question: publicQ,
      subtitles,
    });
  }

  if (publicBlocks.length !== 2) {
    throw new ListeningPublicationError(
      LISTENING_ERRORS.VALIDATION_FAILED,
      'Número inválido de blocos no episódio.',
      episodeId,
    );
  }

  return {
    episode: {
      id: episode.id,
      title: episode.title,
      synopsis: episode.synopsis ?? null,
      cefrLevel: episode.cefr_level,
      estimatedDurationSeconds: episode.estimated_duration_seconds ?? 0,
      actualDurationSeconds: episode.actual_duration_seconds ?? 0,
    },
    blocks: publicBlocks as [PublicListeningBlock, PublicListeningBlock],
  };
}
