export type ListeningAudioAssetStatus =
  | 'pending'
  | 'processing'
  | 'uploaded'
  | 'validated'
  | 'failed';

export type ListeningWordTimingStatus = 'complete' | 'partial' | 'missing' | 'invalid';

export type ListeningAudioDurationStatus = 'valid' | 'needs_review' | 'invalid';

export interface ListeningAudioAsset {
  id: string;
  episodeId: string;
  blockId: string;
  blockOrder: 1 | 2;
  audioPath: string | null;
  audioFormat: string;
  contentType: string;
  fileSizeBytes: number | null;
  durationMs: number | null;
  voiceName: string;
  locale: string;
  ssmlHash: string;
  audioHash: string | null;
  wordTimingStatus: ListeningWordTimingStatus | null;
  durationStatus: ListeningAudioDurationStatus | null;
  synthesisConfigVersion: string;
  status: ListeningAudioAssetStatus;
  rawSynthesisEventsJson: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListeningBookmarkTiming {
  audioAssetId: string;
  bookmarkName: string;
  eventOrder: number;
  offsetMs: number;
  rawOffsetTicks: number;
}

export interface ListeningWordTiming {
  audioAssetId: string;
  wordOrder: number;
  text: string;
  startMs: number;
  durationMs: number | null;
  endMs: number | null;
  textOffset: number | null;
  wordLength: number | null;
  boundaryType: string | null;
  rawOffsetTicks: number | null;
  rawDurationTicks: number | null;
}

export interface RawListeningBookmarkEvent {
  bookmarkName: string;
  audioOffsetTicks: number;
  receivedOrder: number;
}

export interface RawListeningWordBoundaryEvent {
  text: string;
  audioOffsetTicks: number;
  durationTicks: number | null;
  textOffset: number | null;
  wordLength: number | null;
  boundaryType: string | null;
  receivedOrder: number;
}

export interface ListeningSynthesisRawResult {
  audioData: ArrayBuffer;
  audioDurationTicks: number;
  bookmarkEvents: RawListeningBookmarkEvent[];
  wordBoundaryEvents: RawListeningWordBoundaryEvent[];
  resultId: string;
}

export interface ListeningSynthesisCancellation {
  reason: string;
  errorCode: string;
  errorDetails: string;
  retryable: boolean;
}

export interface ListeningAzureSpeechConfig {
  subscriptionKey: string;
  region: string;
  voiceName: string;
  locale: string;
  outputFormatValue: number;
  synthesisTimeoutMs: number;
  maxRetries: number;
  synthesisConfigVersion: string;
}

export interface SynthesizeListeningEpisodeInput {
  episodeId: string;
  forceRegeneration?: boolean;
  blockFilter?: 1 | 2;
  validateOnly?: boolean;
}

export interface ListeningAudioBlockResult {
  blockId: string;
  blockOrder: 1 | 2;
  audioAssetId: string;
  audioPath: string;
  durationMs: number;
  fileSizeBytes: number;
  audioHash: string;
  ssmlHash: string;
  bookmarkCount: number;
  wordTimingCount: number;
  wordTimingStatus: ListeningWordTimingStatus;
  status: 'validated';
}

export interface SynthesizeListeningEpisodeResult {
  episodeId: string;
  blocks: ListeningAudioBlockResult[];
  actualDurationSeconds: number;
  audioStatus: 'ready' | 'partial';
}

export interface ListeningBookmarkValidationResult {
  valid: boolean;
  missing: string[];
  duplicated: string[];
  unexpected: string[];
  outOfOrder: string[];
  offsetsDecreasing: string[];
}

export interface SynthesizeListeningBlockInput {
  blockId: string;
  blockOrder: 1 | 2;
  episodeId: string;
  cefrLevel: string;
  contentVersion: number;
  ssml: string;
  ssmlHash: string;
  expectedBookmarks: string[];
}
