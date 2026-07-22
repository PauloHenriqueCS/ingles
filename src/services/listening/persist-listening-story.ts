import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidatedStory, ValidatedBlock } from './listening-story-schema';

export class StoryPersistError extends Error {
  readonly code = 'STORY_PERSIST_ERROR';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StoryPersistError';
  }
}

export interface ExistingEpisodeByGenerationKey {
  id: string;
  status: string;
  cefrLevel: string;
}

/**
 * The get-or-create read side: is there already a persisted episode for this
 * exact (cefrLevel, theme, seed, prompt/content version) generation key?
 * `generation_key` is UNIQUE in the DB, so a second insert with the same key
 * (e.g. a job retried after failing downstream of persistence) would violate
 * the constraint — callers must check this first and reuse the existing row
 * instead of generating and inserting fresh content.
 */
export async function findListeningEpisodeByGenerationKey(
  supabase: SupabaseClient,
  generationKey: string,
): Promise<ExistingEpisodeByGenerationKey | null> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .select('id, status, cefr_level')
    .eq('generation_key', generationKey)
    .maybeSingle();

  if (error) throw new StoryPersistError(`Failed to look up episode by generation_key: ${error.message}`, error);
  if (!data) return null;
  const row = data as { id: string; status: string; cefr_level: string };
  return { id: row.id, status: row.status, cefrLevel: row.cefr_level };
}

function isGenerationKeyConflict(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' && (error.message ?? '').includes('generation_key');
}

async function insertEpisode(
  supabase: SupabaseClient,
  story: ValidatedStory,
  idempotencyKey: string,
  theme?: string | null,
): Promise<{ id: string; created: boolean }> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .insert({
      title: story.title,
      synopsis: story.synopsis,
      cefr_level: story.cefrLevel,
      status: 'draft',
      content_version: 1,
      generation_key: idempotencyKey,
      ...(theme ? { theme } : {}),
    })
    .select('id')
    .single();

  if (!error) return { id: (data as { id: string }).id, created: true };

  // Race: another process persisted the same generation_key between the
  // caller's own pre-check and this insert. Reuse the winner's row instead
  // of failing — never retry the insert with a different key just to avoid
  // the conflict, that would defeat the point of the key being deterministic.
  if (isGenerationKeyConflict(error)) {
    const existing = await findListeningEpisodeByGenerationKey(supabase, idempotencyKey);
    if (existing) return { id: existing.id, created: false };
  }

  throw new StoryPersistError(`Failed to insert episode: ${error.message}`, error);
}

async function insertBlock(
  supabase: SupabaseClient,
  episodeId: string,
  block: ValidatedBlock,
): Promise<string> {
  const { data, error } = await supabase
    .from('listening_blocks')
    .insert({
      episode_id: episodeId,
      block_order: block.blockOrder,
      text_en: block.textEn,
      // translation_pt is nullable — filled by PREPARE_LISTENING_SUBTITLES
      status: 'draft',
    })
    .select('id')
    .single();

  if (error) throw new StoryPersistError(`Failed to insert block ${block.blockOrder}: ${error.message}`, error);
  return (data as { id: string }).id;
}

async function insertSentences(
  supabase: SupabaseClient,
  blockId: string,
  block: ValidatedBlock,
): Promise<void> {
  const rows = block.sentences.map(s => ({
    block_id: blockId,
    sentence_key: s.sentenceKey,
    sentence_order: s.sentenceOrder,
    paragraph_order: s.paragraphOrder,
    speaker: s.speaker,
    text_en: s.textEn,
  }));

  const { error } = await supabase.from('listening_sentences').insert(rows);
  if (error) throw new StoryPersistError(`Failed to insert sentences for block ${block.blockOrder}: ${error.message}`, error);
}

async function markContentReady(
  supabase: SupabaseClient,
  episodeId: string,
  blockIds: string[],
): Promise<void> {
  const { error: epErr } = await supabase
    .from('listening_episodes')
    .update({ status: 'content_ready' })
    .eq('id', episodeId);

  if (epErr) throw new StoryPersistError(`Failed to update episode status: ${epErr.message}`, epErr);

  for (const blockId of blockIds) {
    const { error: bErr } = await supabase
      .from('listening_blocks')
      .update({ status: 'content_ready' })
      .eq('id', blockId);
    if (bErr) throw new StoryPersistError(`Failed to update block status: ${bErr.message}`, bErr);
  }
}

export async function persistListeningStory(
  story: ValidatedStory,
  idempotencyKey: string,
  supabase: SupabaseClient,
  theme?: string | null,
): Promise<string> {
  const episode = await insertEpisode(supabase, story, idempotencyKey, theme);

  if (!episode.created) {
    // Lost a race to another process that persisted this exact
    // generation_key first — its blocks/sentences are already there (or on
    // their way). Reuse its episode id and discard the story we just
    // generated rather than inserting a second, duplicate set of blocks.
    return episode.id;
  }

  const blockIds: string[] = [];
  for (const block of story.blocks) {
    const blockId = await insertBlock(supabase, episode.id, block);
    blockIds.push(blockId);
    await insertSentences(supabase, blockId, block);
    // Questions are generated by GENERATE_LISTENING_QUESTIONS (downstream job)
  }

  await markContentReady(supabase, episode.id, blockIds);
  return episode.id;
}
