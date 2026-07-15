import type { SupabaseClient } from '@supabase/supabase-js';
import { synchronizeListeningBlock } from './synchronize-listening-block';
import { updateEpisodeTimingStatus } from './persist-listening-timings';
import { DEFAULT_TIMING_CONFIG, ALIGNER_VERSION, TIMING_CONFIG_VERSION } from './listening-timing-config';
import type {
  SynchronizeListeningEpisodeInput,
  SynchronizeListeningEpisodeResult,
  ListeningBlockSynchronizationResult,
  ListeningSubtitleTimingConfig,
} from './listening-timing-types';

// ─── Error classes ────────────────────────────────────────────────────────────

export class ListeningTimingEpisodeNotFoundError extends Error {
  readonly code = 'LISTENING_TIMING_EPISODE_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode not found: ${episodeId}`);
    this.name = 'ListeningTimingEpisodeNotFoundError';
  }
}

export class ListeningTimingPublishedEpisodeError extends Error {
  readonly code = 'LISTENING_TIMING_PUBLISHED_EPISODE';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode ${episodeId} is published and cannot be re-synchronized`);
    this.name = 'ListeningTimingPublishedEpisodeError';
  }
}

export class ListeningTimingInvalidBlockStructureError extends Error {
  readonly code = 'LISTENING_TIMING_INVALID_BLOCK_STRUCTURE';
  readonly retryable = false;
  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = 'ListeningTimingInvalidBlockStructureError';
  }
}

export class ListeningTimingAudioNotReadyError extends Error {
  readonly code = 'LISTENING_TIMING_AUDIO_NOT_READY';
  readonly retryable = false;
  constructor(readonly episodeId: string, blockOrder: number) {
    super(`Episode ${episodeId} block ${blockOrder} has no validated audio asset`);
    this.name = 'ListeningTimingAudioNotReadyError';
  }
}

export class ListeningTimingVersionMismatchError extends Error {
  readonly code = 'LISTENING_TIMING_VERSION_MISMATCH';
  readonly retryable = false;
  constructor(readonly episodeId: string, _blockOrder: number, message: string) {
    super(message);
    this.name = 'ListeningTimingVersionMismatchError';
  }
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  status: string;
  content_version: number;
}

interface BlockRow {
  id: string;
  block_order: number;
  ssml_content_hash: string | null;
}

interface AudioAssetRow {
  id: string;
  ssml_hash: string;
  audio_hash: string | null;
  duration_ms: number | null;
  status: string;
}

// ─── Main episode synchronizer ────────────────────────────────────────────────

export async function synchronizeListeningEpisode(
  input: SynchronizeListeningEpisodeInput,
  supabase: SupabaseClient,
  config: ListeningSubtitleTimingConfig = DEFAULT_TIMING_CONFIG,
): Promise<SynchronizeListeningEpisodeResult> {
  const { episodeId, forceRegeneration = false, blockFilter, validateOnly = false } = input;

  // Load episode
  const { data: episodeData, error: episodeError } = await supabase
    .from('listening_episodes')
    .select('id, status, content_version')
    .eq('id', episodeId)
    .single();

  if (episodeError || !episodeData)
    throw new ListeningTimingEpisodeNotFoundError(episodeId);

  const episode = episodeData as EpisodeRow;

  if (episode.status === 'published')
    throw new ListeningTimingPublishedEpisodeError(episodeId);

  // Load blocks
  const { data: blocksData, error: blocksError } = await supabase
    .from('listening_blocks')
    .select('id, block_order, ssml_content_hash')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (blocksError)
    throw new ListeningTimingInvalidBlockStructureError(episodeId, `Failed to load blocks: ${blocksError.message}`);

  const blocks = (blocksData ?? []) as BlockRow[];

  if (blocks.length !== 2) {
    throw new ListeningTimingInvalidBlockStructureError(
      episodeId,
      `Expected 2 blocks, found ${blocks.length}`,
    );
  }

  const targetBlocks = blockFilter
    ? blocks.filter(b => b.block_order === blockFilter)
    : blocks;

  // Load validated audio assets for each target block
  const blockAudioMap = new Map<string, AudioAssetRow>();
  for (const block of targetBlocks) {
    const { data: assetData } = await supabase
      .from('listening_audio_assets')
      .select('id, ssml_hash, audio_hash, duration_ms, status')
      .eq('block_id', block.id)
      .eq('status', 'validated')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!assetData)
      throw new ListeningTimingAudioNotReadyError(episodeId, block.block_order);

    const asset = assetData as AudioAssetRow;

    // Validate hash consistency
    if (block.ssml_content_hash && asset.ssml_hash !== block.ssml_content_hash) {
      throw new ListeningTimingVersionMismatchError(
        episodeId,
        block.block_order,
        `Block ssml_content_hash (${block.ssml_content_hash}) != asset ssml_hash (${asset.ssml_hash})`,
      );
    }

    if (!asset.audio_hash) {
      throw new ListeningTimingVersionMismatchError(
        episodeId,
        block.block_order,
        `Audio asset ${asset.id} has no audio_hash`,
      );
    }

    blockAudioMap.set(block.id, asset);
  }

  // ── Validate-only mode ────────────────────────────────────────────────────
  if (validateOnly) {
    console.error(JSON.stringify({
      event: 'listening_timing_validate_only',
      episodeId, blockCount: targetBlocks.length,
      timingConfigVersion: TIMING_CONFIG_VERSION, t: Date.now(),
    }));
    return {
      episodeId,
      blocks: [],
      timingStatus: 'ready',
      alignerVersion: ALIGNER_VERSION,
    };
  }

  // ── Mark episode processing ───────────────────────────────────────────────
  await supabase
    .from('listening_episodes')
    .update({ timing_status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', episodeId);

  // ── Synchronize each block ────────────────────────────────────────────────
  const blockResults: ListeningBlockSynchronizationResult[] = [];

  for (const block of targetBlocks) {
    const asset = blockAudioMap.get(block.id)!;

    const result = await synchronizeListeningBlock(
      {
        blockId: block.id,
        blockOrder: block.block_order as 1 | 2,
        episodeId,
        audioAssetId: asset.id,
        ssmlHash: asset.ssml_hash,
        audioHash: asset.audio_hash!,
        audioDurationMs: asset.duration_ms ?? 0,
        contentVersion: episode.content_version,
        forceRegeneration,
      },
      supabase,
      config,
    );

    blockResults.push(result);
  }

  // ── Determine overall timing status ──────────────────────────────────────
  const allReady = blockResults.every(r => r.status === 'ready');
  const timingStatus: 'ready' | 'needs_review' = allReady ? 'ready' : 'needs_review';

  // Only mark episode ready if both blocks were synchronized
  const allBlocksSynced = !blockFilter && blockResults.length === 2;
  if (allBlocksSynced) {
    await updateEpisodeTimingStatus(supabase, episodeId, timingStatus);
  }

  return {
    episodeId,
    blocks: blockResults,
    timingStatus,
    alignerVersion: ALIGNER_VERSION,
  };
}
