import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SynthesizeListeningEpisodeInput,
  SynthesizeListeningEpisodeResult,
  ListeningAudioBlockResult,
} from './listening-audio-types';
import { buildListeningAzureSpeechConfig } from './listening-audio-config';
import { synthesizeListeningBlock } from './synthesize-listening-block';
import { SSML_GENERATOR_VERSION } from '../listening-ssml-config';

// ─── Error classes ──────────────────────────────────────────────────────────

export class ListeningSsmlNotReadyError extends Error {
  readonly code = 'LISTENING_SSML_NOT_READY';
  readonly retryable = false;
  constructor(readonly episodeId: string, blockOrder: number, ssmlStatus: string | null) {
    super(`Block ${blockOrder} SSML not ready (status: ${ssmlStatus})`);
    this.name = 'ListeningSsmlNotReadyError';
  }
}

export class ListeningSsmlHashMismatchError extends Error {
  readonly code = 'LISTENING_SSML_HASH_MISMATCH';
  readonly retryable = false;
  constructor(readonly episodeId: string, blockOrder: number) {
    super(`Block ${blockOrder} SSML hash missing`);
    this.name = 'ListeningSsmlHashMismatchError';
  }
}

export class ListeningEpisodeNotReadyForAudioError extends Error {
  readonly code = 'LISTENING_EPISODE_NOT_READY_FOR_AUDIO';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly status: string) {
    super(`Episode ${episodeId} not ready for audio synthesis (status: ${status})`);
    this.name = 'ListeningEpisodeNotReadyForAudioError';
  }
}

export class ListeningPublishedEpisodeImmutableError extends Error {
  readonly code = 'LISTENING_PUBLISHED_EPISODE_IMMUTABLE';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode ${episodeId} is published and cannot be modified`);
    this.name = 'ListeningPublishedEpisodeImmutableError';
  }
}

export class ListeningEpisodeNotFoundError extends Error {
  readonly code = 'LISTENING_EPISODE_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode not found: ${episodeId}`);
    this.name = 'ListeningEpisodeNotFoundError';
  }
}

export class ListeningInvalidBlockStructureError extends Error {
  readonly code = 'LISTENING_INVALID_BLOCK_STRUCTURE';
  readonly retryable = false;
  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = 'ListeningInvalidBlockStructureError';
  }
}

export class ListeningMissingSentencesError extends Error {
  readonly code = 'LISTENING_MISSING_SENTENCES';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly blockOrder: number) {
    super(`No sentences for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningMissingSentencesError';
  }
}

// ─── DB row types ───────────────────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  status: string;
  cefr_level: string;
  content_version: number;
  voice_name: string | null;
  locale: string | null;
}

interface BlockRow {
  id: string;
  block_order: number;
  ssml: string | null;
  ssml_status: string | null;
  ssml_generator_version: string | null;
  ssml_content_hash: string | null;
  audio_status: string | null;
}

interface SentenceRow {
  block_id: string;
  sentence_key: string;
  sentence_order: number;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function loadEpisode(supabase: SupabaseClient, episodeId: string): Promise<EpisodeRow> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .select('id, status, cefr_level, content_version, voice_name, locale')
    .eq('id', episodeId)
    .single();
  if (error || !data) throw new ListeningEpisodeNotFoundError(episodeId);
  return data as EpisodeRow;
}

async function loadBlocks(supabase: SupabaseClient, episodeId: string): Promise<BlockRow[]> {
  const { data, error } = await supabase
    .from('listening_blocks')
    .select('id, block_order, ssml, ssml_status, ssml_generator_version, ssml_content_hash, audio_status')
    .eq('episode_id', episodeId)
    .order('block_order');
  if (error) throw new ListeningInvalidBlockStructureError(episodeId, `Failed to load blocks: ${error.message}`);
  return (data ?? []) as BlockRow[];
}

async function loadSentences(supabase: SupabaseClient, blockIds: string[]): Promise<SentenceRow[]> {
  const { data, error } = await supabase
    .from('listening_sentences')
    .select('block_id, sentence_key, sentence_order')
    .in('block_id', blockIds)
    .order('sentence_order');
  if (error) throw new Error(`Failed to load sentences: ${error.message}`);
  return (data ?? []) as SentenceRow[];
}

function buildExpectedBookmarks(blockOrder: 1 | 2, sentenceKeys: string[]): string[] {
  return [`block-${blockOrder}-start`, ...sentenceKeys, `block-${blockOrder}-end`];
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

export async function synthesizeListeningEpisode(
  input: SynthesizeListeningEpisodeInput,
  supabase: SupabaseClient,
  azureKey?: string,
  azureRegion?: string,
): Promise<SynthesizeListeningEpisodeResult> {
  const { episodeId, forceRegeneration = false, blockFilter, validateOnly = false } = input;

  const episode = await loadEpisode(supabase, episodeId);

  if (episode.status === 'published') throw new ListeningPublishedEpisodeImmutableError(episodeId);

  const blocks = await loadBlocks(supabase, episodeId);
  if (blocks.length !== 2) {
    throw new ListeningInvalidBlockStructureError(episodeId,
      `Episode must have exactly 2 blocks, found ${blocks.length}`);
  }

  const sortedBlocks = [...blocks].sort((a, b) => a.block_order - b.block_order);
  const targetBlocks = blockFilter
    ? sortedBlocks.filter(b => b.block_order === blockFilter)
    : sortedBlocks;

  // Validate SSML readiness for each target block
  for (const block of targetBlocks) {
    if (block.ssml_status !== 'ready' || block.ssml_generator_version !== SSML_GENERATOR_VERSION) {
      throw new ListeningSsmlNotReadyError(episodeId, block.block_order, block.ssml_status);
    }
    if (!block.ssml_content_hash) {
      throw new ListeningSsmlHashMismatchError(episodeId, block.block_order);
    }
  }

  // Load sentences for expected bookmark calculation
  const allSentences = await loadSentences(supabase, sortedBlocks.map(b => b.id));

  if (validateOnly) {
    // Dry-run: validate config and bookmarks without calling Azure
    const key = azureKey ?? process.env.AZURE_SPEECH_KEY ?? '';
    const region = azureRegion ?? process.env.AZURE_SPEECH_REGION ?? '';
    buildListeningAzureSpeechConfig(key, region, episode.voice_name ?? 'en-US-AvaMultilingualNeural', episode.locale ?? 'en-US');

    for (const block of targetBlocks) {
      const sentenceKeys = allSentences
        .filter(s => s.block_id === block.id)
        .sort((a, b) => a.sentence_order - b.sentence_order)
        .map(s => s.sentence_key);
      if (sentenceKeys.length === 0) throw new ListeningMissingSentencesError(episodeId, block.block_order);
      buildExpectedBookmarks(block.block_order as 1 | 2, sentenceKeys);
    }

    console.error(JSON.stringify({ event: 'listening_audio_validate_only', episodeId, t: Date.now() }));
    return {
      episodeId,
      blocks: [],
      actualDurationSeconds: 0,
      audioStatus: 'partial',
    };
  }

  // Build Azure config
  const key = azureKey ?? process.env.AZURE_SPEECH_KEY ?? '';
  const region = azureRegion ?? process.env.AZURE_SPEECH_REGION ?? '';
  const voiceName = episode.voice_name ?? 'en-US-AvaMultilingualNeural';
  const locale = episode.locale ?? 'en-US';
  const azureConfig = buildListeningAzureSpeechConfig(key, region, voiceName, locale);

  // Mark episode as processing
  await supabase
    .from('listening_episodes')
    .update({ audio_status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', episodeId);

  const blockResults: ListeningAudioBlockResult[] = [];

  for (const block of targetBlocks) {
    const sentenceKeys = allSentences
      .filter(s => s.block_id === block.id)
      .sort((a, b) => a.sentence_order - b.sentence_order)
      .map(s => s.sentence_key);

    if (sentenceKeys.length === 0) {
      throw new ListeningMissingSentencesError(episodeId, block.block_order);
    }

    // Skip block if already validated and not forcing regeneration
    if (!forceRegeneration && block.audio_status === 'validated') {
      // Block already validated — load existing result
      const { data: existingAsset } = await supabase
        .from('listening_audio_assets')
        .select('id, audio_path, duration_ms, file_size_bytes, audio_hash, word_timing_status, ssml_hash')
        .eq('block_id', block.id)
        .eq('status', 'validated')
        .maybeSingle();

      if (existingAsset) {
        const ea = existingAsset as {
          id: string; audio_path: string; duration_ms: number;
          file_size_bytes: number; audio_hash: string; word_timing_status: string; ssml_hash: string;
        };
        blockResults.push({
          blockId: block.id,
          blockOrder: block.block_order as 1 | 2,
          audioAssetId: ea.id,
          audioPath: ea.audio_path,
          durationMs: ea.duration_ms,
          fileSizeBytes: ea.file_size_bytes,
          audioHash: ea.audio_hash,
          ssmlHash: ea.ssml_hash,
          bookmarkCount: sentenceKeys.length + 2,
          wordTimingCount: 0,
          wordTimingStatus: ea.word_timing_status as 'complete' | 'partial' | 'missing' | 'invalid',
          status: 'validated',
        });
        continue;
      }
    }

    const blockResult = await synthesizeListeningBlock(
      {
        blockId: block.id,
        blockOrder: block.block_order as 1 | 2,
        episodeId,
        cefrLevel: episode.cefr_level,
        contentVersion: episode.content_version,
        ssml: block.ssml!,
        ssmlHash: block.ssml_content_hash!,
        expectedBookmarks: buildExpectedBookmarks(block.block_order as 1 | 2, sentenceKeys),
      },
      azureConfig,
      supabase,
      episode.cefr_level,
    );

    blockResults.push(blockResult);
  }

  const totalDurationMs = blockResults.reduce((acc, b) => acc + b.durationMs, 0);
  const actualDurationSeconds = Math.round(totalDurationMs / 1000);

  // Update episode
  const allTargetsDone = targetBlocks.length === 2 && blockResults.length === 2;
  const audioStatus = allTargetsDone ? 'ready' : 'partial';

  await supabase
    .from('listening_episodes')
    .update({
      audio_status: audioStatus,
      actual_duration_seconds: allTargetsDone ? actualDurationSeconds : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', episodeId);

  if (allTargetsDone) {
    console.error(JSON.stringify({
      event: 'listening_audio_episode_ready',
      episodeId,
      actualDurationSeconds,
      block1DurationMs: blockResults[0]?.durationMs,
      block2DurationMs: blockResults[1]?.durationMs,
      t: Date.now(),
    }));
  }

  return {
    episodeId,
    blocks: blockResults,
    actualDurationSeconds,
    audioStatus: audioStatus as 'ready' | 'partial',
  };
}
