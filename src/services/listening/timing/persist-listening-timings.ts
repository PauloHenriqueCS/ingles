import type { SupabaseClient } from '@supabase/supabase-js';
import { TIMING_CONFIG_VERSION } from './listening-timing-config';
import type {
  ListeningSentenceTiming,
  ListeningCueTiming,
  ListeningTimingManifest,
} from './listening-timing-types';

export interface PersistListeningTimingsInput {
  supabase: SupabaseClient;
  blockId: string;
  blockOrder: 1 | 2;
  episodeId: string;
  audioAssetId: string;
  ssmlHash: string;
  audioHash: string;
  audioDurationMs: number;
  sentenceTimings: ListeningSentenceTiming[];
  enCueTimings: ListeningCueTiming[];
  ptCueTimings: ListeningCueTiming[];
  enCueIds: Map<string, string>;   // cueKey → DB id (EN)
  ptCueIds: Map<string, string>;   // cueKey → DB id (PT)
  timingHash: string;
  manifest: ListeningTimingManifest;
  timingStatus: 'ready' | 'needs_review';
}

export async function persistListeningTimings(
  input: PersistListeningTimingsInput,
): Promise<void> {
  const {
    supabase, blockId, audioAssetId,
    ssmlHash, audioHash, sentenceTimings,
    enCueTimings, ptCueTimings, enCueIds, ptCueIds,
    timingHash, manifest, timingStatus,
  } = input;

  const now = new Date().toISOString();

  // 1. Upsert sentence timings
  if (sentenceTimings.length > 0) {
    const rows = sentenceTimings.map(s => ({
      audio_asset_id: audioAssetId,
      block_id: blockId,
      sentence_key: s.sentenceKey,
      sentence_order: s.sentenceOrder,
      start_ms: s.startMs,
      spoken_end_ms: s.spokenEndMs,
      interval_end_ms: s.intervalEndMs,
      timing_confidence: s.timingConfidence,
      updated_at: now,
    }));
    const { error } = await supabase
      .from('listening_sentence_timings')
      .upsert(rows, { onConflict: 'audio_asset_id,sentence_key' });
    if (error) throw new Error(`LISTENING_TIMING_PERSIST_ERROR: sentence_timings: ${error.message}`);
  }

  // 2. Update EN subtitle cues
  for (const ct of enCueTimings) {
    const cueId = enCueIds.get(ct.cueKey);
    if (!cueId) continue;
    const { error } = await supabase
      .from('listening_subtitle_cues')
      .update({
        start_ms: ct.startMs,
        end_ms: ct.endMs,
        timing_source: ct.timingSource,
        timing_confidence: ct.confidence,
        audio_asset_id: audioAssetId,
        ssml_hash: ssmlHash,
        audio_hash: audioHash,
        status: timingStatus === 'needs_review' ? 'needs_review' : 'timed',
        timed_at: now,
        updated_at: now,
      })
      .eq('id', cueId);
    if (error) throw new Error(`LISTENING_TIMING_PERSIST_ERROR: EN cue ${ct.cueKey}: ${error.message}`);
  }

  // 3. Update PT subtitle cues (mirror EN timings)
  for (const ct of ptCueTimings) {
    const cueId = ptCueIds.get(ct.cueKey);
    if (!cueId) continue;
    const { error } = await supabase
      .from('listening_subtitle_cues')
      .update({
        start_ms: ct.startMs,
        end_ms: ct.endMs,
        timing_source: ct.timingSource,
        timing_confidence: ct.confidence,
        audio_asset_id: audioAssetId,
        ssml_hash: ssmlHash,
        audio_hash: audioHash,
        status: timingStatus === 'needs_review' ? 'needs_review' : 'timed',
        timed_at: now,
        updated_at: now,
      })
      .eq('id', cueId);
    if (error) throw new Error(`LISTENING_TIMING_PERSIST_ERROR: PT cue ${ct.cueKey}: ${error.message}`);
  }

  // 4. Update audio asset with timing hash and manifest
  const { error: assetError } = await supabase
    .from('listening_audio_assets')
    .update({ timing_hash: timingHash, timing_manifest_json: manifest, updated_at: now })
    .eq('id', audioAssetId);
  if (assetError)
    throw new Error(`LISTENING_TIMING_PERSIST_ERROR: audio_asset: ${assetError.message}`);

  // 5. Update block timing state
  const { error: blockError } = await supabase
    .from('listening_blocks')
    .update({
      timing_status: timingStatus,
      timing_generated_at: now,
      timing_version: 1,
      timing_config_version: TIMING_CONFIG_VERSION,
      updated_at: now,
    })
    .eq('id', blockId);
  if (blockError)
    throw new Error(`LISTENING_TIMING_PERSIST_ERROR: listening_blocks: ${blockError.message}`);

  // Episode update is handled by synchronize-listening-episode after all blocks
}

export async function updateEpisodeTimingStatus(
  supabase: SupabaseClient,
  episodeId: string,
  timingStatus: 'ready' | 'needs_review' | 'failed',
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('listening_episodes')
    .update({
      timing_status: timingStatus,
      timing_generated_at: now,
      timing_version: 1,
      timing_config_version: TIMING_CONFIG_VERSION,
      updated_at: now,
    })
    .eq('id', episodeId);
  if (error)
    throw new Error(`LISTENING_TIMING_PERSIST_ERROR: listening_episodes: ${error.message}`);
}
