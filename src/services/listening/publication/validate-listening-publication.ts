import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ListeningPublicationValidationResult,
  type ListeningPublicationValidationIssue,
  type ListeningPublicationValidationChecks,
} from './listening-publication-types';
import { LISTENING_BUCKET, VALID_EPISODE_DURATION_RANGE, REQUIRED_BLOCKS_PER_EPISODE } from './listening-publication-config';
import { getListeningServiceClient } from './_supabase';

const NOT_PUBLISHABLE_STATUSES = new Set(['pending', 'invalid', 'needs_review']);

function err(
  code: string,
  message: string,
  episodeId: string,
  blockId?: string,
  field?: string,
): ListeningPublicationValidationIssue {
  return { code, message, episodeId, blockId, field };
}

async function storageFileExists(
  supabase: SupabaseClient,
  path: string,
): Promise<{ exists: boolean; sizeBytes: number }> {
  const folder = path.substring(0, path.lastIndexOf('/'));
  const filename = path.substring(path.lastIndexOf('/') + 1);
  const { data, error } = await supabase.storage
    .from(LISTENING_BUCKET)
    .list(folder, { search: filename });

  if (error || !data) return { exists: false, sizeBytes: 0 };
  const file = data.find((f) => f.name === filename);
  if (!file) return { exists: false, sizeBytes: 0 };
  const size = (file.metadata as any)?.size ?? 0;
  return { exists: true, sizeBytes: Number(size) };
}

export async function validateListeningEpisodeForPublication(
  episodeId: string,
  supabase?: SupabaseClient,
): Promise<ListeningPublicationValidationResult> {
  const client = supabase ?? getListeningServiceClient();
  const errors: ListeningPublicationValidationIssue[] = [];
  const warnings: ListeningPublicationValidationIssue[] = [];
  const checks: ListeningPublicationValidationChecks = {
    episodeStructureValid: false,
    blocksValid: false,
    questionsValid: false,
    subtitlesValid: false,
    ssmlValid: false,
    audioValid: false,
    timingsValid: false,
    hashesValid: false,
    storageFilesValid: false,
    durationValid: false,
  };

  // ── Episódio ──────────────────────────────────────────────────────────────

  const { data: episode, error: epError } = await client
    .from('listening_episodes')
    .select('id, status, cefr_level, content_version, actual_duration_seconds, estimated_duration_seconds, publication_version')
    .eq('id', episodeId)
    .maybeSingle();

  if (epError || !episode) {
    errors.push(err('EPISODE_NOT_FOUND', 'Episódio não encontrado.', episodeId));
    return { valid: false, episodeId, checks, errors, warnings };
  }

  if (episode.status === 'archived') {
    errors.push(err('EPISODE_ARCHIVED', 'Episódio está arquivado.', episodeId));
    return { valid: false, episodeId, checks, errors, warnings };
  }

  if (episode.status === 'published') {
    errors.push(err('EPISODE_ALREADY_PUBLISHED', 'Episódio já está publicado.', episodeId));
    return { valid: false, episodeId, checks, errors, warnings };
  }

  if (episode.status !== 'ready') {
    errors.push(err('EPISODE_NOT_READY', `Status do episódio inválido: ${episode.status}.`, episodeId));
  }

  // ── Blocos ────────────────────────────────────────────────────────────────

  const { data: blocks, error: blError } = await client
    .from('listening_blocks')
    .select('id, block_order, status, ssml, ssml_content_hash, duration_ms')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (blError || !blocks) {
    errors.push(err('BLOCKS_LOAD_FAILED', 'Erro ao carregar blocos.', episodeId));
    return { valid: false, episodeId, checks, errors, warnings };
  }

  if (blocks.length !== REQUIRED_BLOCKS_PER_EPISODE) {
    errors.push(err('WRONG_BLOCK_COUNT', `Esperado ${REQUIRED_BLOCKS_PER_EPISODE} blocos, encontrado ${blocks.length}.`, episodeId));
  }

  const block1 = blocks.find((b) => b.block_order === 1);
  const block2 = blocks.find((b) => b.block_order === 2);

  if (!block1) errors.push(err('BLOCK_1_MISSING', 'Bloco 1 ausente.', episodeId));
  if (!block2) errors.push(err('BLOCK_2_MISSING', 'Bloco 2 ausente.', episodeId));

  let blocksOk = !!block1 && !!block2;

  if (block1 && NOT_PUBLISHABLE_STATUSES.has(block1.status)) {
    errors.push(err('BLOCK_STATUS_INVALID', `Bloco 1 status: ${block1.status}.`, episodeId, block1.id));
    blocksOk = false;
  }
  if (block2 && NOT_PUBLISHABLE_STATUSES.has(block2.status)) {
    errors.push(err('BLOCK_STATUS_INVALID', `Bloco 2 status: ${block2.status}.`, episodeId, block2.id));
    blocksOk = false;
  }

  checks.blocksValid = blocksOk;

  // ── SSML ──────────────────────────────────────────────────────────────────

  let ssmlOk = true;
  for (const block of blocks) {
    if (!block.ssml) {
      errors.push(err('SSML_MISSING', 'SSML ausente.', episodeId, block.id));
      ssmlOk = false;
    }
    if (!block.ssml_content_hash) {
      errors.push(err('SSML_HASH_MISSING', 'ssml_content_hash ausente.', episodeId, block.id));
      ssmlOk = false;
    }
  }
  checks.ssmlValid = ssmlOk;

  // ── Perguntas ─────────────────────────────────────────────────────────────

  const blockIds = blocks.map((b) => b.id);

  const { data: questions, error: qError } = await client
    .from('listening_questions')
    .select('id, episode_id, block_id, question_order, validation_status, options_json')
    .eq('episode_id', episodeId);

  if (qError || !questions) {
    errors.push(err('QUESTIONS_LOAD_FAILED', 'Erro ao carregar perguntas.', episodeId));
    return { valid: false, episodeId, checks, errors, warnings };
  }

  let questionsOk = true;

  if (questions.length !== REQUIRED_BLOCKS_PER_EPISODE) {
    errors.push(err('WRONG_QUESTION_COUNT', `Esperado ${REQUIRED_BLOCKS_PER_EPISODE} perguntas, encontrado ${questions.length}.`, episodeId));
    questionsOk = false;
  }

  for (const block of blocks) {
    const blockQ = questions.filter((q) => q.block_id === block.id);
    if (blockQ.length !== 1) {
      errors.push(err('BLOCK_QUESTION_COUNT', `Bloco ${block.block_order} tem ${blockQ.length} pergunta(s), esperado 1.`, episodeId, block.id));
      questionsOk = false;
      continue;
    }
    const q = blockQ[0];
    if (q.validation_status !== 'valid') {
      errors.push(err('QUESTION_NOT_VALID', `Pergunta do bloco ${block.block_order} com validation_status=${q.validation_status}.`, episodeId, block.id));
      questionsOk = false;
    }
    if (NOT_PUBLISHABLE_STATUSES.has(q.validation_status)) {
      errors.push(err('QUESTION_STATUS_BLOCKS', `Pergunta está em estado bloqueante: ${q.validation_status}.`, episodeId, block.id));
      questionsOk = false;
    }
    const opts = Array.isArray(q.options_json) ? q.options_json : [];
    if (opts.length < 2) {
      errors.push(err('QUESTION_OPTIONS_INVALID', 'Pergunta com menos de 2 opções.', episodeId, block.id));
      questionsOk = false;
    }
  }

  checks.questionsValid = questionsOk;

  // ── Legendas ──────────────────────────────────────────────────────────────

  let subtitlesOk = true;

  if (blockIds.length > 0) {
    const { data: cues, error: cueError } = await client
      .from('listening_subtitle_cues')
      .select('id, block_id, language, cue_order, start_ms, end_ms')
      .in('block_id', blockIds);

    if (cueError || !cues) {
      errors.push(err('SUBTITLES_LOAD_FAILED', 'Erro ao carregar legendas.', episodeId));
      subtitlesOk = false;
    } else {
      for (const block of blocks) {
        const enCues = cues.filter((c) => c.block_id === block.id && c.language === 'en');
        const ptCues = cues.filter((c) => c.block_id === block.id && c.language === 'pt-BR');

        if (enCues.length === 0) {
          errors.push(err('SUBTITLES_EN_MISSING', `Bloco ${block.block_order} sem legendas em inglês.`, episodeId, block.id));
          subtitlesOk = false;
        }
        if (ptCues.length === 0) {
          errors.push(err('SUBTITLES_PT_MISSING', `Bloco ${block.block_order} sem legendas em português.`, episodeId, block.id));
          subtitlesOk = false;
        }

        for (const cue of [...enCues, ...ptCues]) {
          if (cue.end_ms <= cue.start_ms) {
            errors.push(err('SUBTITLE_TIMING_INVALID', `Cue ${cue.cue_order} com endMs <= startMs.`, episodeId, block.id));
            subtitlesOk = false;
          }
        }
      }
    }
  }

  checks.subtitlesValid = subtitlesOk;

  // ── Áudio assets ──────────────────────────────────────────────────────────

  const { data: assets, error: assetError } = await client
    .from('listening_audio_assets')
    .select('id, block_id, ssml_hash, audio_hash, staging_path, published_path, file_size_bytes, duration_ms, status')
    .eq('episode_id', episodeId);

  if (assetError || !assets) {
    errors.push(err('AUDIO_ASSETS_LOAD_FAILED', 'Erro ao carregar audio assets.', episodeId));
    return { valid: false, episodeId, checks, errors, warnings };
  }

  let audioOk = true;

  for (const block of blocks) {
    const asset = assets.find((a) => a.block_id === block.id);
    if (!asset) {
      errors.push(err('AUDIO_ASSET_MISSING', `Bloco ${block.block_order} sem audio asset.`, episodeId, block.id));
      audioOk = false;
      continue;
    }
    if (asset.status !== 'ready') {
      errors.push(err('AUDIO_ASSET_NOT_READY', `Audio asset do bloco ${block.block_order} status=${asset.status}.`, episodeId, block.id));
      audioOk = false;
    }
    if (!asset.staging_path) {
      errors.push(err('AUDIO_STAGING_PATH_MISSING', `Bloco ${block.block_order} sem staging_path.`, episodeId, block.id));
      audioOk = false;
    }
    if (!asset.ssml_hash) {
      errors.push(err('AUDIO_SSML_HASH_MISSING', `Bloco ${block.block_order} sem ssml_hash.`, episodeId, block.id));
      audioOk = false;
    }
    if (!asset.audio_hash) {
      errors.push(err('AUDIO_HASH_MISSING', `Bloco ${block.block_order} sem audio_hash.`, episodeId, block.id));
      audioOk = false;
    }
  }

  checks.audioValid = audioOk;

  // ── Timings ───────────────────────────────────────────────────────────────

  let timingsOk = true;

  if (assets.length > 0) {
    const assetIds = assets.map((a) => a.id);
    const { data: timings, error: timingError } = await client
      .from('listening_timing_artifacts')
      .select('id, audio_asset_id, block_id, ssml_hash, audio_hash, timing_hash, status')
      .in('audio_asset_id', assetIds);

    if (timingError || !timings) {
      errors.push(err('TIMINGS_LOAD_FAILED', 'Erro ao carregar timing artifacts.', episodeId));
      timingsOk = false;
    } else {
      for (const block of blocks) {
        const asset = assets.find((a) => a.block_id === block.id);
        if (!asset) continue;
        const timing = timings.find((t) => t.audio_asset_id === asset.id);
        if (!timing) {
          errors.push(err('TIMING_MISSING', `Bloco ${block.block_order} sem timing artifact.`, episodeId, block.id));
          timingsOk = false;
          continue;
        }
        if (timing.status !== 'ready') {
          errors.push(err('TIMING_NOT_READY', `Timing do bloco ${block.block_order} status=${timing.status}.`, episodeId, block.id));
          timingsOk = false;
        }
      }

      // ── Hashes ─────────────────────────────────────────────────────────────

      let hashesOk = true;

      for (const block of blocks) {
        const asset = assets.find((a) => a.block_id === block.id);
        if (!asset) continue;

        // bloco.ssml_content_hash == audio_asset.ssml_hash
        if (block.ssml_content_hash && asset.ssml_hash && block.ssml_content_hash !== asset.ssml_hash) {
          errors.push(err('HASH_MISMATCH_SSML_BLOCK_ASSET', `bloco.ssml_content_hash ≠ audio_asset.ssml_hash no bloco ${block.block_order}.`, episodeId, block.id));
          hashesOk = false;
        }

        const timing = timings.find((t) => t.audio_asset_id === asset.id);
        if (!timing) continue;

        // timing.audio_hash == audio_asset.audio_hash
        if (timing.audio_hash !== asset.audio_hash) {
          errors.push(err('HASH_MISMATCH_AUDIO', `timing.audio_hash ≠ audio_asset.audio_hash no bloco ${block.block_order}.`, episodeId, block.id));
          hashesOk = false;
        }

        // timing.ssml_hash == audio_asset.ssml_hash
        if (timing.ssml_hash !== asset.ssml_hash) {
          errors.push(err('HASH_MISMATCH_SSML', `timing.ssml_hash ≠ audio_asset.ssml_hash no bloco ${block.block_order}.`, episodeId, block.id));
          hashesOk = false;
        }
      }

      checks.hashesValid = hashesOk;
    }
  }

  checks.timingsValid = timingsOk;

  // ── Existência dos arquivos no Storage ────────────────────────────────────

  let storageOk = true;

  for (const asset of assets) {
    const block = blocks.find((b) => b.id === asset.block_id);
    if (!asset.staging_path) continue;

    const { exists, sizeBytes } = await storageFileExists(client, asset.staging_path);
    if (!exists) {
      errors.push(err('STORAGE_FILE_NOT_FOUND', `Arquivo de staging não encontrado: ${asset.staging_path}`, episodeId, block?.id));
      storageOk = false;
    } else if (sizeBytes === 0) {
      errors.push(err('STORAGE_FILE_EMPTY', `Arquivo de staging vazio: ${asset.staging_path}`, episodeId, block?.id));
      storageOk = false;
    }
  }

  checks.storageFilesValid = storageOk;

  // ── Duração ───────────────────────────────────────────────────────────────

  let durationOk = true;
  const durationSecs = episode.actual_duration_seconds ?? episode.estimated_duration_seconds;

  if (!durationSecs) {
    warnings.push(err('DURATION_UNKNOWN', 'Duração do episódio desconhecida.', episodeId));
  } else if (
    durationSecs < VALID_EPISODE_DURATION_RANGE.minSeconds ||
    durationSecs > VALID_EPISODE_DURATION_RANGE.maxSeconds
  ) {
    errors.push(err('DURATION_OUT_OF_RANGE', `Duração ${durationSecs}s fora do intervalo [${VALID_EPISODE_DURATION_RANGE.minSeconds}, ${VALID_EPISODE_DURATION_RANGE.maxSeconds}]s.`, episodeId));
    durationOk = false;
  }

  checks.durationValid = durationOk;

  // ── Estrutura do episódio (síntese) ──────────────────────────────────────

  checks.episodeStructureValid =
    blocks.length === REQUIRED_BLOCKS_PER_EPISODE &&
    !!block1 &&
    !!block2 &&
    episode.status !== 'archived' &&
    episode.status !== 'published';

  const valid = errors.length === 0;
  return { valid, episodeId, checks, errors, warnings };
}
