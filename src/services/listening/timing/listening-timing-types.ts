export type ListeningTimingSource =
  | 'word_boundaries'
  | 'sentence_bookmarks'
  | 'hybrid'
  | 'fallback';

export type ListeningTimingStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'needs_review'
  | 'failed';

// ─── Alignment ───────────────────────────────────────────────────────────────

export interface ListeningAlignedWord {
  canonicalWord: string;
  azureText: string;
  canonicalOrder: number;
  eventOrder: number | null;
  startMs: number | null;
  endMs: number | null;
  matchType: 'exact' | 'normalized' | 'split' | 'merged' | 'missing' | 'extra';
}

export interface ListeningWordAlignmentMetrics {
  canonicalWordCount: number;
  azureEventCount: number;
  alignedWordCount: number;
  exactMatchCount: number;
  normalizedMatchCount: number;
  missingWordCount: number;
  extraEventCount: number;
  alignmentRate: number;
}

export interface ListeningAlignmentResult {
  words: ListeningAlignedWord[];
  metrics: ListeningWordAlignmentMetrics;
}

// ─── Timings ─────────────────────────────────────────────────────────────────

export interface ListeningSentenceTiming {
  sentenceKey: string;
  sentenceOrder: number;
  startMs: number;
  spokenEndMs: number;
  intervalEndMs: number;
  timingConfidence: number;
}

export interface ListeningCueTiming {
  cueKey: string;
  cueOrder: number;
  startMs: number;
  endMs: number;
  sourceSentenceKeys: string[];
  timingSource: ListeningTimingSource;
  confidence: number;
}

export interface ListeningCueTimingConfidence {
  score: number;
  alignedWordRatio: number;
  usedFallback: boolean;
  issues: string[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ListeningSubtitleTimingConfig {
  preRollMs: number;
  postRollMs: number;
  maxGapMs: number;
  maxOverlapMs: number;
  minCueDurationMs: number;
  maxCueDurationMs: number;
  alignmentRateThresholdValid: number;
  alignmentRateThresholdReview: number;
  confidenceThresholdValid: number;
  confidenceThresholdReview: number;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface ListeningTimingManifest {
  schemaVersion: string;
  episodeId: string;
  blockId: string;
  audioAssetId: string;
  audioDurationMs: number;
  ssmlHash: string;
  audioHash: string;
  alignerVersion: string;
  timingConfigVersion: string;
  sentences: Array<{
    sentenceKey: string;
    startMs: number;
    spokenEndMs: number;
    intervalEndMs: number;
  }>;
  cues: Array<{
    cueKey: string;
    startMs: number;
    endMs: number;
    confidence: number;
    timingSource: ListeningTimingSource;
  }>;
}

// ─── DB row shapes (snake_case from Supabase) ────────────────────────────────

export interface SentenceRow {
  id: string;
  sentence_key: string;
  sentence_order: number;
  text_en: string;
}

export interface BookmarkTimingRow {
  bookmark_name: string;
  event_order: number;
  offset_ms: number;
}

export interface WordTimingRow {
  word_order: number;
  text: string;
  start_ms: number;
  duration_ms: number | null;
  end_ms: number | null;
  text_offset: number | null;
  word_length: number | null;
  boundary_type: string | null;
}

export interface CueRow {
  id: string;
  cue_key: string;
  cue_order: number;
  language: string;
  text: string;
  source_sentence_keys: string[];
  content_version: number;
}

// ─── Block sync input/output ─────────────────────────────────────────────────

export interface SynchronizeListeningBlockInput {
  blockId: string;
  blockOrder: 1 | 2;
  episodeId: string;
  audioAssetId: string;
  ssmlHash: string;
  audioHash: string;
  audioDurationMs: number;
  contentVersion: number;
  forceRegeneration?: boolean;
}

export interface ListeningBlockSynchronizationResult {
  blockId: string;
  blockOrder: 1 | 2;
  audioAssetId: string;
  sentenceTimingCount: number;
  cueTimingCount: number;
  alignmentRate: number;
  averageConfidence: number;
  timingHash: string;
  status: 'ready' | 'needs_review';
}

// ─── Episode sync input/output ────────────────────────────────────────────────

export interface SynchronizeListeningEpisodeInput {
  episodeId: string;
  forceRegeneration?: boolean;
  blockFilter?: 1 | 2;
  validateOnly?: boolean;
}

export interface SynchronizeListeningEpisodeResult {
  episodeId: string;
  blocks: ListeningBlockSynchronizationResult[];
  timingStatus: 'ready' | 'needs_review';
  alignerVersion: string;
}
