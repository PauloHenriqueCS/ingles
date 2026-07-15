import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ListeningBookmarkTiming,
  ListeningWordTiming,
  ListeningWordTimingStatus,
  ListeningAudioDurationStatus,
} from './listening-audio-types';
import { AUDIO_FORMAT_LABEL, AUDIO_CONTENT_TYPE } from './listening-audio-config';

export interface PersistListeningAudioInput {
  supabase: SupabaseClient;
  episodeId: string;
  blockId: string;
  blockOrder: 1 | 2;
  audioPath: string;
  fileSizeBytes: number;
  durationMs: number;
  voiceName: string;
  locale: string;
  ssmlHash: string;
  audioHash: string;
  synthesisConfigVersion: string;
  wordTimingStatus: ListeningWordTimingStatus;
  durationStatus: ListeningAudioDurationStatus;
  bookmarkTimings: ListeningBookmarkTiming[];
  wordTimings: ListeningWordTiming[];
  rawSynthesisEventsJson: unknown;
}

export interface PersistListeningAudioResult {
  audioAssetId: string;
}

export async function persistListeningAudio(
  input: PersistListeningAudioInput,
): Promise<PersistListeningAudioResult> {
  const { supabase, blockId, ssmlHash, synthesisConfigVersion } = input;

  // Upsert audio asset
  const assetRow = {
    episode_id: input.episodeId,
    block_id: blockId,
    block_order: input.blockOrder,
    audio_path: input.audioPath,
    audio_format: AUDIO_FORMAT_LABEL,
    content_type: AUDIO_CONTENT_TYPE,
    file_size_bytes: input.fileSizeBytes,
    duration_ms: input.durationMs,
    voice_name: input.voiceName,
    locale: input.locale,
    ssml_hash: ssmlHash,
    audio_hash: input.audioHash,
    word_timing_status: input.wordTimingStatus,
    duration_status: input.durationStatus,
    synthesis_config_version: synthesisConfigVersion,
    status: 'validated' as const,
    raw_synthesis_events_json: input.rawSynthesisEventsJson,
    error_code: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  };

  const { data: assetData, error: assetError } = await supabase
    .from('listening_audio_assets')
    .upsert(assetRow, { onConflict: 'block_id,ssml_hash,synthesis_config_version' })
    .select('id')
    .single();

  if (assetError || !assetData) {
    throw new Error(`LISTENING_AUDIO_PERSISTENCE_ERROR: failed to upsert asset: ${assetError?.message}`);
  }

  const audioAssetId = (assetData as { id: string }).id;

  // Delete existing timings before reinserting (idempotent)
  await supabase.from('listening_bookmark_timings').delete().eq('audio_asset_id', audioAssetId);
  await supabase.from('listening_word_timings').delete().eq('audio_asset_id', audioAssetId);

  // Insert bookmark timings
  if (input.bookmarkTimings.length > 0) {
    const { error: bmError } = await supabase.from('listening_bookmark_timings').insert(
      input.bookmarkTimings.map(t => ({
        audio_asset_id: audioAssetId,
        bookmark_name: t.bookmarkName,
        event_order: t.eventOrder,
        offset_ms: t.offsetMs,
        raw_offset_ticks: t.rawOffsetTicks,
      })),
    );
    if (bmError) {
      throw new Error(`LISTENING_AUDIO_PERSISTENCE_ERROR: failed to insert bookmarks: ${bmError.message}`);
    }
  }

  // Insert word timings
  if (input.wordTimings.length > 0) {
    const { error: wdError } = await supabase.from('listening_word_timings').insert(
      input.wordTimings.map(t => ({
        audio_asset_id: audioAssetId,
        word_order: t.wordOrder,
        text: t.text,
        start_ms: t.startMs,
        duration_ms: t.durationMs,
        end_ms: t.endMs,
        text_offset: t.textOffset,
        word_length: t.wordLength,
        boundary_type: t.boundaryType,
        raw_offset_ticks: t.rawOffsetTicks,
        raw_duration_ticks: t.rawDurationTicks,
      })),
    );
    if (wdError) {
      throw new Error(`LISTENING_AUDIO_PERSISTENCE_ERROR: failed to insert word timings: ${wdError.message}`);
    }
  }

  // Update listening_blocks
  const { error: blockError } = await supabase
    .from('listening_blocks')
    .update({
      audio_status: 'validated',
      audio_asset_id: audioAssetId,
      audio_path: input.audioPath,
      duration_ms: input.durationMs,
      updated_at: new Date().toISOString(),
    })
    .eq('id', blockId);

  if (blockError) {
    throw new Error(`LISTENING_AUDIO_PERSISTENCE_ERROR: failed to update block: ${blockError.message}`);
  }

  return { audioAssetId };
}
