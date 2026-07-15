import type { SupabaseClient } from '@supabase/supabase-js';
import { alignListeningWordTimings } from './align-listening-word-timings';
import { buildListeningSentenceTimings } from './build-listening-sentence-timings';
import { buildListeningCueTimings } from './build-listening-cue-timings';
import { validateListeningTimings } from './validate-listening-timings';
import { buildListeningTimingManifest } from './build-listening-timing-manifest';
import { computeListeningTimingHash } from './hash-listening-timings';
import { persistListeningTimings } from './persist-listening-timings';
import { DEFAULT_TIMING_CONFIG, ALIGNER_VERSION } from './listening-timing-config';
import type {
  SentenceRow,
  BookmarkTimingRow,
  WordTimingRow,
  CueRow,
  ListeningAlignedWord,
  SynchronizeListeningBlockInput,
  ListeningBlockSynchronizationResult,
  ListeningSubtitleTimingConfig,
} from './listening-timing-types';

// ─── Error classes ────────────────────────────────────────────────────────────

export class ListeningTimingHashMismatchError extends Error {
  readonly code = 'LISTENING_TIMING_HASH_MISMATCH';
  readonly retryable = false;
  constructor(readonly blockId: string, message: string) {
    super(message);
    this.name = 'ListeningTimingHashMismatchError';
  }
}

export class ListeningTimingMissingDataError extends Error {
  readonly code = 'LISTENING_TIMING_MISSING_DATA';
  readonly retryable = false;
  constructor(readonly blockId: string, message: string) {
    super(message);
    this.name = 'ListeningTimingMissingDataError';
  }
}

export class ListeningTimingAlignmentError extends Error {
  readonly code = 'LISTENING_TIMING_ALIGNMENT_ERROR';
  readonly retryable = false;
  constructor(readonly blockId: string, readonly alignmentRate: number, message: string) {
    super(message);
    this.name = 'ListeningTimingAlignmentError';
  }
}

// ─── DB loading helpers ───────────────────────────────────────────────────────

async function loadSentences(supabase: SupabaseClient, blockId: string): Promise<SentenceRow[]> {
  const { data, error } = await supabase
    .from('listening_sentences')
    .select('id, sentence_key, sentence_order, text_en')
    .eq('block_id', blockId)
    .order('sentence_order');
  if (error) throw new Error(`Failed to load sentences: ${error.message}`);
  return (data ?? []) as SentenceRow[];
}

async function loadBookmarks(
  supabase: SupabaseClient,
  audioAssetId: string,
): Promise<BookmarkTimingRow[]> {
  const { data, error } = await supabase
    .from('listening_bookmark_timings')
    .select('bookmark_name, event_order, offset_ms')
    .eq('audio_asset_id', audioAssetId)
    .order('event_order');
  if (error) throw new Error(`Failed to load bookmarks: ${error.message}`);
  return (data ?? []) as BookmarkTimingRow[];
}

async function loadWordTimings(
  supabase: SupabaseClient,
  audioAssetId: string,
): Promise<WordTimingRow[]> {
  const { data, error } = await supabase
    .from('listening_word_timings')
    .select('word_order, text, start_ms, duration_ms, end_ms, text_offset, word_length, boundary_type')
    .eq('audio_asset_id', audioAssetId)
    .order('word_order');
  if (error) throw new Error(`Failed to load word timings: ${error.message}`);
  return (data ?? []) as WordTimingRow[];
}

async function loadCues(
  supabase: SupabaseClient,
  blockId: string,
  language: string,
): Promise<CueRow[]> {
  const { data, error } = await supabase
    .from('listening_subtitle_cues')
    .select('id, cue_key, cue_order, language, text, source_sentence_keys, content_version')
    .eq('block_id', blockId)
    .eq('language', language)
    .order('cue_order');
  if (error) throw new Error(`Failed to load cues (${language}): ${error.message}`);
  return (data ?? []) as CueRow[];
}

async function loadExistingTimingHash(
  supabase: SupabaseClient,
  audioAssetId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('listening_audio_assets')
    .select('timing_hash')
    .eq('id', audioAssetId)
    .single();
  return (data as { timing_hash: string | null } | null)?.timing_hash ?? null;
}

// ─── Main block synchronizer ──────────────────────────────────────────────────

export async function synchronizeListeningBlock(
  input: SynchronizeListeningBlockInput,
  supabase: SupabaseClient,
  config: ListeningSubtitleTimingConfig = DEFAULT_TIMING_CONFIG,
): Promise<ListeningBlockSynchronizationResult> {
  const {
    blockId, blockOrder, episodeId, audioAssetId,
    ssmlHash, audioHash, audioDurationMs, contentVersion,
    forceRegeneration = false,
  } = input;

  console.error(JSON.stringify({
    event: 'listening_timing_started',
    episodeId, blockId, blockOrder, audioAssetId, t: Date.now(),
  }));

  // ── Idempotency check ─────────────────────────────────────────────────────
  if (!forceRegeneration) {
    const existingHash = await loadExistingTimingHash(supabase, audioAssetId);
    if (existingHash) {
      // Already timed — load result summary from DB
      const { data: existingSentences } = await supabase
        .from('listening_sentence_timings')
        .select('sentence_key')
        .eq('audio_asset_id', audioAssetId);
      const { data: existingCues } = await supabase
        .from('listening_subtitle_cues')
        .select('cue_key, timing_confidence')
        .eq('block_id', blockId)
        .eq('language', 'en')
        .not('start_ms', 'is', null);

      const cueList = (existingCues ?? []) as {cue_key: string; timing_confidence: number | null}[];
      const avgConf = cueList.length > 0
        ? cueList.reduce((s, c) => s + (c.timing_confidence ?? 0.9), 0) / cueList.length
        : 0.9;

      console.error(JSON.stringify({
        event: 'listening_timing_idempotent',
        episodeId, blockId, timingHash: existingHash, t: Date.now(),
      }));

      return {
        blockId, blockOrder, audioAssetId,
        sentenceTimingCount: (existingSentences ?? []).length,
        cueTimingCount: cueList.length,
        alignmentRate: 1.0,
        averageConfidence: avgConf,
        timingHash: existingHash,
        status: avgConf >= config.confidenceThresholdValid ? 'ready' : 'needs_review',
      };
    }
  }

  // ── Load data from DB ─────────────────────────────────────────────────────
  const [sentences, bookmarks, wordTimings, enCues, ptCues] = await Promise.all([
    loadSentences(supabase, blockId),
    loadBookmarks(supabase, audioAssetId),
    loadWordTimings(supabase, audioAssetId),
    loadCues(supabase, blockId, 'en'),
    loadCues(supabase, blockId, 'pt-BR'),
  ]);

  if (sentences.length === 0)
    throw new ListeningTimingMissingDataError(blockId, `No sentences for block ${blockId}`);
  if (enCues.length === 0)
    throw new ListeningTimingMissingDataError(blockId, `No EN cues for block ${blockId}`);

  // Verify content versions match
  const cueVersion = enCues[0]?.content_version;
  if (cueVersion !== undefined && cueVersion !== contentVersion) {
    throw new ListeningTimingHashMismatchError(
      blockId,
      `EN cue content_version ${cueVersion} != episode content_version ${contentVersion}`,
    );
  }

  // Mark block as processing
  await supabase
    .from('listening_blocks')
    .update({ timing_status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', blockId);

  // ── Build sentence timings ─────────────────────────────────────────────────
  const sentenceTimings = buildListeningSentenceTimings(
    sentences, bookmarks, wordTimings, blockOrder,
  );

  // ── Align words per sentence ───────────────────────────────────────────────
  const alignedWordsBySentence = new Map<string, ListeningAlignedWord[]>();
  let totalAlignmentRate = 0;

  for (const sentence of sentences) {
    const st = sentenceTimings.find(t => t.sentenceKey === sentence.sentence_key);
    const startMs = st?.startMs ?? 0;
    const endMs = st?.intervalEndMs ?? audioDurationMs;

    // Filter word timings to this sentence's temporal range
    const sentenceWords = wordTimings.filter(
      w => w.start_ms >= startMs - 50 && w.start_ms < endMs + 50,
    );

    const result = alignListeningWordTimings(sentence.text_en, sentenceWords);
    alignedWordsBySentence.set(sentence.sentence_key, result.words);
    totalAlignmentRate += result.metrics.alignmentRate;
  }

  const alignmentRate = sentences.length > 0 ? totalAlignmentRate / sentences.length : 1.0;

  console.error(JSON.stringify({
    event: 'listening_word_alignment_completed',
    episodeId, blockId, alignmentRate,
    sentenceCount: sentences.length, t: Date.now(),
  }));

  // Reject if alignment rate too low
  if (alignmentRate < config.alignmentRateThresholdReview) {
    throw new ListeningTimingAlignmentError(
      blockId,
      alignmentRate,
      `Word alignment rate ${alignmentRate.toFixed(3)} below threshold ${config.alignmentRateThresholdReview}`,
    );
  }

  // ── Build sentence timings result ─────────────────────────────────────────
  console.error(JSON.stringify({
    event: 'listening_sentence_timings_created',
    episodeId, blockId, count: sentenceTimings.length, t: Date.now(),
  }));

  // ── Build cue timings (EN) ─────────────────────────────────────────────────
  const enCueTimings = buildListeningCueTimings(
    enCues, sentences, sentenceTimings, alignedWordsBySentence, audioDurationMs, config,
  );

  // ── Mirror timings to PT ───────────────────────────────────────────────────
  const enTimingByCueKey = new Map(enCueTimings.map(c => [c.cueKey, c]));
  const ptCueTimings = ptCues.map(ptCue => {
    const en = enTimingByCueKey.get(ptCue.cue_key);
    if (!en)
      throw new ListeningTimingMissingDataError(
        blockId,
        `No EN timing for PT cue ${ptCue.cue_key}`,
      );
    return { ...en, cueOrder: ptCue.cue_order };
  });

  console.error(JSON.stringify({
    event: 'listening_cue_timings_created',
    episodeId, blockId, enCount: enCueTimings.length, ptCount: ptCueTimings.length, t: Date.now(),
  }));

  // ── Validate ───────────────────────────────────────────────────────────────
  const validation = validateListeningTimings(
    sentenceTimings, enCueTimings, ptCueTimings, audioDurationMs, config,
  );

  console.error(JSON.stringify({
    event: 'listening_timing_validation_completed',
    episodeId, blockId, valid: validation.valid,
    errors: validation.errors.length, warnings: validation.warnings.length, t: Date.now(),
  }));

  if (!validation.valid) {
    throw new Error(
      `LISTENING_TIMING_INVALID: ${validation.errors.join('; ')}`,
    );
  }

  // ── Determine status ───────────────────────────────────────────────────────
  const avgConfidence =
    enCueTimings.length > 0
      ? enCueTimings.reduce((s, c) => s + c.confidence, 0) / enCueTimings.length
      : 1.0;

  const timingStatus: 'ready' | 'needs_review' =
    alignmentRate >= config.alignmentRateThresholdValid &&
    avgConfidence >= config.confidenceThresholdValid
      ? 'ready'
      : 'needs_review';

  if (timingStatus === 'needs_review') {
    console.error(JSON.stringify({
      event: 'listening_timing_needs_review',
      episodeId, blockId, alignmentRate, avgConfidence, t: Date.now(),
    }));
  }

  // ── Build manifest and hash ────────────────────────────────────────────────
  const manifest = buildListeningTimingManifest(
    episodeId, blockId, audioAssetId, audioDurationMs,
    ssmlHash, audioHash, sentenceTimings, enCueTimings,
  );

  const timingHash = computeListeningTimingHash(
    audioAssetId, ssmlHash, audioHash, sentenceTimings, enCueTimings,
  );

  // ── Persist ────────────────────────────────────────────────────────────────
  const enCueIds = new Map(enCues.map(c => [c.cue_key, c.id]));
  const ptCueIds = new Map(ptCues.map(c => [c.cue_key, c.id]));

  await persistListeningTimings({
    supabase,
    blockId, blockOrder, episodeId, audioAssetId,
    ssmlHash, audioHash, audioDurationMs,
    sentenceTimings, enCueTimings, ptCueTimings,
    enCueIds, ptCueIds,
    timingHash, manifest, timingStatus,
  });

  console.error(JSON.stringify({
    event: 'listening_timing_completed',
    episodeId, blockId, blockOrder, timingHash, timingStatus,
    sentenceCount: sentenceTimings.length, cueCount: enCueTimings.length,
    alignmentRate, avgConfidence, alignerVersion: ALIGNER_VERSION,
    t: Date.now(),
  }));

  return {
    blockId, blockOrder, audioAssetId,
    sentenceTimingCount: sentenceTimings.length,
    cueTimingCount: enCueTimings.length,
    alignmentRate,
    averageConfidence: avgConfidence,
    timingHash,
    status: timingStatus,
  };
}
