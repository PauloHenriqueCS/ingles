import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ListeningSsmlConfig,
  ListeningBlockSsmlResult,
  GenerateListeningSsmlInput,
  GenerateListeningSsmlResult,
} from './listening-ssml-types';
import { DEFAULT_SSML_CONFIG, SSML_GENERATOR_VERSION } from './listening-ssml-config';
import type { ListeningSentence } from '../../domain/listening/listening-types';
import { buildListeningSsmlBlock } from './build-listening-ssml-block';
import { validateListeningSsmlStructure } from './validate-listening-ssml';
import { validateListeningSsmlBookmarks } from './validate-listening-ssml-bookmarks';
import { validateSpokenTextPreservation } from './normalize-listening-spoken-text';
import { persistListeningSsml } from './persist-listening-ssml';

// ─── Error classes ─────────────────────────────────────────────────────────────

export class ListeningSsmlEpisodeNotFoundError extends Error {
  readonly code = 'SSML_EPISODE_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode not found: ${episodeId}`);
    this.name = 'ListeningSsmlEpisodeNotFoundError';
  }
}

export class ListeningSsmlPublishedError extends Error {
  readonly code = 'SSML_EPISODE_PUBLISHED';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode ${episodeId} is published and cannot be modified`);
    this.name = 'ListeningSsmlPublishedError';
  }
}

export class ListeningSsmlInvalidBlockStructureError extends Error {
  readonly code = 'SSML_INVALID_BLOCK_STRUCTURE';
  readonly retryable = false;
  constructor(
    readonly episodeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ListeningSsmlInvalidBlockStructureError';
  }
}

export class ListeningSsmlMissingSentencesError extends Error {
  readonly code = 'SSML_MISSING_SENTENCES';
  readonly retryable = false;
  constructor(
    readonly episodeId: string,
    readonly blockOrder: number,
  ) {
    super(`No sentences found for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningSsmlMissingSentencesError';
  }
}

export class ListeningSsmlValidationError extends Error {
  readonly code = 'SSML_VALIDATION_FAILED';
  readonly retryable = false;
  constructor(
    readonly episodeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ListeningSsmlValidationError';
  }
}

// ─── DB row types ──────────────────────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  status: string;
  voice_name: string | null;
  locale: string | null;
}

interface BlockRow {
  id: string;
  block_order: number;
  ssml_status: string | null;
  ssml_generator_version: string | null;
  ssml_version: number | null;
  ssml_content_hash: string | null;
  ssml: string | null;
}

interface SentenceRow {
  id: string;
  block_id: string;
  sentence_key: string;
  sentence_order: number;
  paragraph_order: number;
  speaker: string | null;
  text_en: string;
  created_at: string;
}

// ─── DB query helpers ──────────────────────────────────────────────────────────

async function loadEpisode(supabase: SupabaseClient, episodeId: string): Promise<EpisodeRow> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .select('id, status, voice_name, locale')
    .eq('id', episodeId)
    .single();

  if (error || !data) throw new ListeningSsmlEpisodeNotFoundError(episodeId);
  return data as EpisodeRow;
}

async function loadBlocks(supabase: SupabaseClient, episodeId: string): Promise<BlockRow[]> {
  const { data, error } = await supabase
    .from('listening_blocks')
    .select('id, block_order, ssml_status, ssml_generator_version, ssml_version, ssml_content_hash, ssml')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (error) {
    throw new ListeningSsmlInvalidBlockStructureError(episodeId, `Failed to load blocks: ${error.message}`);
  }
  return (data ?? []) as BlockRow[];
}

async function loadSentences(supabase: SupabaseClient, blockIds: string[]): Promise<SentenceRow[]> {
  const { data, error } = await supabase
    .from('listening_sentences')
    .select('id, block_id, sentence_key, sentence_order, paragraph_order, speaker, text_en, created_at')
    .in('block_id', blockIds)
    .order('sentence_order');

  if (error) throw new Error(`Failed to load sentences: ${error.message}`);
  return (data ?? []) as SentenceRow[];
}

// ─── Content hash ──────────────────────────────────────────────────────────────

export function computeSsmlContentHash(
  sentences: Pick<ListeningSentence, 'sentenceKey' | 'textEn' | 'sentenceOrder' | 'paragraphOrder'>[],
  config: ListeningSsmlConfig,
): string {
  const sorted = [...sentences].sort((a, b) => a.sentenceOrder - b.sentenceOrder);
  const input = JSON.stringify({
    sentences: sorted.map(s => ({ k: s.sentenceKey, t: s.textEn, o: s.sentenceOrder, p: s.paragraphOrder })),
    voice: config.voice,
    pauses: config.pauses,
    prosody: config.prosody,
    generatorVersion: config.generatorVersion,
    pronunciationRulesVersion: config.pronunciationRulesVersion,
    rules: config.pronunciationRules,
  });
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

// ─── Idempotent result from existing blocks ────────────────────────────────────

function buildIdempotentResult(
  episodeId: string,
  blocks: BlockRow[],
  config: ListeningSsmlConfig,
): GenerateListeningSsmlResult {
  const sorted = [...blocks].sort((a, b) => a.block_order - b.block_order);
  return {
    episodeId,
    voiceName: config.voice.voiceName,
    locale: config.voice.locale,
    blocks: [
      {
        blockId: sorted[0].id,
        blockOrder: 1,
        sentenceCount: 0,
        bookmarkCount: 0,
        ssmlVersion: sorted[0].ssml_version ?? 1,
        contentHash: sorted[0].ssml_content_hash ?? '',
        ssml: sorted[0].ssml ?? '',
      },
      {
        blockId: sorted[1].id,
        blockOrder: 2,
        sentenceCount: 0,
        bookmarkCount: 0,
        ssmlVersion: sorted[1].ssml_version ?? 1,
        contentHash: sorted[1].ssml_content_hash ?? '',
        ssml: sorted[1].ssml ?? '',
      },
    ],
    status: 'ready',
    generatorVersion: SSML_GENERATOR_VERSION,
  };
}

// ─── Main orchestrator ─────────────────────────────────────────────────────────

export async function generateListeningSsml(
  input: GenerateListeningSsmlInput,
  supabase: SupabaseClient,
  config: ListeningSsmlConfig = DEFAULT_SSML_CONFIG,
): Promise<GenerateListeningSsmlResult> {
  const { episodeId, forceRegeneration = false, dryRun = false } = input;

  // 1. Load episode and guard against immutable states
  const episode = await loadEpisode(supabase, episodeId);
  if (episode.status === 'published') throw new ListeningSsmlPublishedError(episodeId);

  // 2. Load blocks and validate structure
  const blocks = await loadBlocks(supabase, episodeId);
  if (blocks.length !== 2) {
    throw new ListeningSsmlInvalidBlockStructureError(
      episodeId,
      `Episode must have exactly 2 blocks, found ${blocks.length}`,
    );
  }
  const sortedBlocks = [...blocks].sort((a, b) => a.block_order - b.block_order);
  if (sortedBlocks[0].block_order !== 1 || sortedBlocks[1].block_order !== 2) {
    throw new ListeningSsmlInvalidBlockStructureError(
      episodeId,
      `Block orders must be [1, 2], got [${sortedBlocks.map(b => b.block_order).join(', ')}]`,
    );
  }

  // 3. Idempotency check: return existing if both blocks are ready at this generator version
  if (!forceRegeneration) {
    const allReady = sortedBlocks.every(
      b => b.ssml_status === 'ready' && b.ssml_generator_version === SSML_GENERATOR_VERSION,
    );
    if (allReady) {
      return buildIdempotentResult(episodeId, sortedBlocks, config);
    }
  }

  // 4. Mark episode as processing
  if (!dryRun) {
    await supabase
      .from('listening_episodes')
      .update({ ssml_status: 'processing' })
      .eq('id', episodeId);
  }

  // 5. Load sentences
  const allSentenceRows = await loadSentences(supabase, sortedBlocks.map(b => b.id));

  // 6. Build and validate SSML for each block
  const blockResults: ListeningBlockSsmlResult[] = [];

  for (const block of sortedBlocks) {
    const blockSentenceRows = allSentenceRows.filter(s => s.block_id === block.id);
    if (blockSentenceRows.length === 0) {
      throw new ListeningSsmlMissingSentencesError(episodeId, block.block_order);
    }

    const sentences = blockSentenceRows.map(
      (s): ListeningSentence => ({
        id: s.id,
        blockId: s.block_id,
        sentenceKey: s.sentence_key,
        sentenceOrder: s.sentence_order,
        paragraphOrder: s.paragraph_order,
        speaker: s.speaker,
        textEn: s.text_en,
        createdAt: s.created_at,
      }),
    );

    const ssml = buildListeningSsmlBlock(sentences, block.block_order as 1 | 2, config);

    try {
      validateListeningSsmlStructure(ssml, block.block_order as 1 | 2);
    } catch (err) {
      throw new ListeningSsmlValidationError(
        episodeId,
        `Block ${block.block_order} structure invalid: ${String(err)}`,
      );
    }

    const bookmarkValidation = validateListeningSsmlBookmarks(ssml, sentences, block.block_order as 1 | 2);
    if (!bookmarkValidation.valid) {
      throw new ListeningSsmlValidationError(
        episodeId,
        `Block ${block.block_order} bookmark validation failed: missing=${JSON.stringify(bookmarkValidation.missing)}, unexpected=${JSON.stringify(bookmarkValidation.unexpected)}, outOfOrder=${JSON.stringify(bookmarkValidation.outOfOrder)}`,
      );
    }

    try {
      validateSpokenTextPreservation(ssml, sentences);
    } catch (err) {
      throw new ListeningSsmlValidationError(
        episodeId,
        `Block ${block.block_order} spoken text mismatch: ${String(err)}`,
      );
    }

    const contentHash = computeSsmlContentHash(sentences, config);

    blockResults.push({
      blockId: block.id,
      blockOrder: block.block_order as 1 | 2,
      sentenceCount: sentences.length,
      bookmarkCount: bookmarkValidation.actualCount,
      ssmlVersion: (block.ssml_version ?? 0) + 1,
      contentHash,
      ssml,
    });
  }

  const result: GenerateListeningSsmlResult = {
    episodeId,
    voiceName: config.voice.voiceName,
    locale: config.voice.locale,
    blocks: [blockResults[0], blockResults[1]] as [ListeningBlockSsmlResult, ListeningBlockSsmlResult],
    status: 'ready',
    generatorVersion: config.generatorVersion,
  };

  // 7. Persist unless dry-run
  if (!dryRun) {
    await persistListeningSsml({
      supabase,
      episodeId,
      voiceName: config.voice.voiceName,
      locale: config.voice.locale,
      blocks: result.blocks,
    });
  }

  return result;
}
