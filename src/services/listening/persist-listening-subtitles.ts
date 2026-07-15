import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidatedTranslatedCue, EnglishCueDraft } from './listening-subtitle-schema';
import { TRANSLATION_PROMPT_VERSION, VALIDATOR_PROMPT_VERSION } from './build-subtitle-translation-prompt';

export class ListeningSubtitlePersistenceError extends Error {
  readonly code = 'LISTENING_SUBTITLE_PERSISTENCE_ERROR';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ListeningSubtitlePersistenceError';
  }
}

export interface PersistSubtitlesInput {
  supabase: SupabaseClient;
  episodeId: string;
  contentVersion: number;
  blockIdByOrder: Map<number, string>;
  englishCues: Map<1 | 2, EnglishCueDraft[]>;
  translatedCues: Map<1 | 2, ValidatedTranslatedCue[]>;
  blockTranslationPt: Map<1 | 2, string>;
}

async function deleteExistingCues(
  supabase: SupabaseClient,
  blockIds: string[],
): Promise<void> {
  const { error } = await supabase
    .from('listening_subtitle_cues')
    .delete()
    .in('block_id', blockIds);
  if (error) {
    throw new ListeningSubtitlePersistenceError(
      `Failed to delete existing subtitle cues: ${error.message}`, error
    );
  }
}

async function insertEnglishCues(
  supabase: SupabaseClient,
  blockId: string,
  blockOrder: 1 | 2,
  cues: EnglishCueDraft[],
  contentVersion: number,
): Promise<void> {
  const rows = cues.map(c => ({
    block_id: blockId,
    language: 'en',
    cue_key: c.cueKey,
    cue_order: c.cueOrder,
    source_sentence_keys: c.sourceSentenceKeys,
    text: c.text,
    start_ms: null,
    end_ms: null,
    status: 'timing_pending',
    content_version: contentVersion,
  }));

  const { error } = await supabase.from('listening_subtitle_cues').insert(rows);
  if (error) {
    throw new ListeningSubtitlePersistenceError(
      `Failed to insert English cues for block ${blockOrder}: ${error.message}`, error
    );
  }
}

async function insertPortugueseCues(
  supabase: SupabaseClient,
  blockId: string,
  blockOrder: 1 | 2,
  cues: ValidatedTranslatedCue[],
  contentVersion: number,
): Promise<void> {
  const rows = cues.map(c => ({
    block_id: blockId,
    language: 'pt-BR',
    cue_key: c.cueKey,
    cue_order: c.cueOrder,
    source_sentence_keys: c.sourceSentenceKeys,
    text: c.textPtBr,
    start_ms: null,
    end_ms: null,
    status: 'timing_pending',
    content_version: contentVersion,
  }));

  const { error } = await supabase.from('listening_subtitle_cues').insert(rows);
  if (error) {
    throw new ListeningSubtitlePersistenceError(
      `Failed to insert Portuguese cues for block ${blockOrder}: ${error.message}`, error
    );
  }
}

async function updateBlockTranslation(
  supabase: SupabaseClient,
  blockId: string,
  blockOrder: 1 | 2,
  translationPt: string,
): Promise<void> {
  const { error } = await supabase
    .from('listening_blocks')
    .update({ translation_pt: translationPt })
    .eq('id', blockId);
  if (error) {
    throw new ListeningSubtitlePersistenceError(
      `Failed to update translation_pt for block ${blockOrder}: ${error.message}`, error
    );
  }
}

async function updateEpisodeSubtitleStatus(
  supabase: SupabaseClient,
  episodeId: string,
  status: 'ready' | 'failed',
): Promise<void> {
  const update: Record<string, unknown> = { subtitles_status: status };
  if (status === 'ready') {
    update.subtitles_generated_at = new Date().toISOString();
    update.subtitle_prompt_version = TRANSLATION_PROMPT_VERSION;
    update.subtitle_validator_prompt_version = VALIDATOR_PROMPT_VERSION;
  }
  const { error } = await supabase
    .from('listening_episodes')
    .update(update)
    .eq('id', episodeId);
  if (error) {
    throw new ListeningSubtitlePersistenceError(
      `Failed to update episode subtitle status to ${status}: ${error.message}`, error
    );
  }
}

/**
 * Persists English + Portuguese subtitle cues transactionally (simulated).
 *
 * Flow:
 * 1. Delete all existing cues for both blocks.
 * 2. Insert English cues for block 1.
 * 3. Insert Portuguese cues for block 1.
 * 4. Insert English cues for block 2.
 * 5. Insert Portuguese cues for block 2.
 * 6. Update translation_pt on both blocks.
 * 7. Mark episode subtitles_status = 'ready'.
 *
 * On any failure: mark episode subtitles_status = 'failed' and re-throw.
 */
export async function persistListeningSubtitles(
  input: PersistSubtitlesInput,
): Promise<void> {
  const {
    supabase, episodeId, contentVersion,
    blockIdByOrder, englishCues, translatedCues, blockTranslationPt,
  } = input;

  const blockIds = [1, 2].map(o => blockIdByOrder.get(o)).filter((id): id is string => !!id);

  try {
    // 1. Delete old cues
    await deleteExistingCues(supabase, blockIds);

    // 2 & 3. Insert for each block
    for (const blockOrder of [1, 2] as const) {
      const blockId = blockIdByOrder.get(blockOrder);
      if (!blockId) throw new ListeningSubtitlePersistenceError(`Block ID not found for order ${blockOrder}`);

      const enCues = englishCues.get(blockOrder);
      if (!enCues) throw new ListeningSubtitlePersistenceError(`No English cues for block ${blockOrder}`);
      await insertEnglishCues(supabase, blockId, blockOrder, enCues, contentVersion);

      const ptCues = translatedCues.get(blockOrder);
      if (!ptCues) throw new ListeningSubtitlePersistenceError(`No Portuguese cues for block ${blockOrder}`);
      await insertPortugueseCues(supabase, blockId, blockOrder, ptCues, contentVersion);

      const translationPt = blockTranslationPt.get(blockOrder);
      if (translationPt) {
        await updateBlockTranslation(supabase, blockId, blockOrder, translationPt);
      }
    }

    // 7. Mark ready
    await updateEpisodeSubtitleStatus(supabase, episodeId, 'ready');
  } catch (err) {
    await updateEpisodeSubtitleStatus(supabase, episodeId, 'failed').catch(() => {});
    throw err;
  }
}
