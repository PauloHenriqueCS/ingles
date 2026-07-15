import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidatedStory, ValidatedBlock } from './listening-story-schema';

export class StoryPersistError extends Error {
  readonly code = 'STORY_PERSIST_ERROR';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StoryPersistError';
  }
}

async function insertEpisode(
  supabase: SupabaseClient,
  story: ValidatedStory,
  idempotencyKey: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .insert({
      title: story.title,
      synopsis: story.synopsis,
      cefr_level: story.cefrLevel,
      status: 'draft',
      content_version: 1,
      generation_key: idempotencyKey,
    })
    .select('id')
    .single();

  if (error) throw new StoryPersistError(`Failed to insert episode: ${error.message}`, error);
  return (data as { id: string }).id;
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
      translation_pt: block.translationPt,
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

async function insertQuestion(
  supabase: SupabaseClient,
  episodeId: string,
  blockId: string,
  block: ValidatedBlock,
): Promise<void> {
  const q = block.question;
  const { error } = await supabase.from('listening_questions').insert({
    episode_id: episodeId,
    block_id: blockId,
    question_order: q.questionOrder,
    prompt: q.prompt,
    options_json: q.optionsJson,
    correct_option: q.correctOption,
    explanation_pt: q.explanationPt,
    max_attempts: 3,
  });

  if (error) throw new StoryPersistError(`Failed to insert question for block ${block.blockOrder}: ${error.message}`, error);
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
): Promise<string> {
  const episodeId = await insertEpisode(supabase, story, idempotencyKey);

  const blockIds: string[] = [];
  for (const block of story.blocks) {
    const blockId = await insertBlock(supabase, episodeId, block);
    blockIds.push(blockId);
    await insertSentences(supabase, blockId, block);
    await insertQuestion(supabase, episodeId, blockId, block);
  }

  await markContentReady(supabase, episodeId, blockIds);
  return episodeId;
}
