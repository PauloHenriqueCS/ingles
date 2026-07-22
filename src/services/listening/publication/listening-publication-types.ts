export type ListeningPublicationStatus =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'archived';

export type ListeningAccessTier = 'free' | 'premium' | 'all';

export type ListeningPublicationValidationIssue = {
  code: string;
  message: string;
  episodeId: string;
  blockId?: string;
  field?: string;
};

export type ListeningPublicationValidationChecks = {
  episodeStructureValid: boolean;
  blocksValid: boolean;
  questionsValid: boolean;
  subtitlesValid: boolean;
  ssmlValid: boolean;
  audioValid: boolean;
  timingsValid: boolean;
  hashesValid: boolean;
  storageFilesValid: boolean;
  durationValid: boolean;
};

export type ListeningPublicationValidationResult = {
  valid: boolean;
  episodeId: string;
  checks: ListeningPublicationValidationChecks;
  errors: ListeningPublicationValidationIssue[];
  warnings: ListeningPublicationValidationIssue[];
};

export type PublicListeningSubtitleCue = {
  cueKey: string;
  cueOrder: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type PublicListeningQuestion = {
  id: string;
  questionOrder: 1 | 2;
  blockId: string;
  prompt: string;
  options: string[];
  maxAttempts: 3;
};

export type PublicListeningAudio = {
  url: string;
  expiresAt: string;
};

export type PublicListeningSubtitles = {
  en: PublicListeningSubtitleCue[];
  ptBr: PublicListeningSubtitleCue[];
};

export type PublicListeningBlock = {
  id: string;
  blockOrder: 1 | 2;
  locked: boolean;
  durationMs: number;
  audio: PublicListeningAudio | null;
  question: PublicListeningQuestion | null;
  subtitles: PublicListeningSubtitles | null;
};

export type PublicListeningEpisodeResponse = {
  episode: {
    id: string;
    title: string;
    synopsis: string | null;
    cefrLevel: string;
    estimatedDurationSeconds: number;
    actualDurationSeconds: number;
  };
  blocks: [PublicListeningBlock, PublicListeningBlock];
};

export type ListeningSignedUrlConfig = {
  expiresInSeconds: number;
  refreshBeforeExpirationSeconds: number;
};

export type ListeningSignedAudio = {
  blockId: string;
  blockOrder: 1 | 2;
  url: string;
  expiresAt: string;
  durationMs: number;
  contentType: string;
};

export type ListeningPublishedAudioAsset = {
  id: string;
  episodeId: string;
  blockId: string;
  ssmlHash: string;
  audioHash: string;
  audioPath: string | null;
  publishedPath: string | null;
  fileSizeBytes: number | null;
  durationMs: number | null;
  contentType: string;
  status: string;
};

export type PublishListeningEpisodeInput = {
  episodeId: string;
  publishedBy?: string;
  publicationSource?: 'admin' | 'system' | 'script';
  force?: false;
};

export type PublishedListeningBlockResult = {
  blockId: string;
  blockOrder: 1 | 2;
  finalAudioPath: string;
  durationMs: number;
  audioHash: string;
};

export type PublishListeningEpisodeResult = {
  episodeId: string;
  publicationStatus: 'published';
  publishedAt: string;
  publicationVersion: number;
  blocks: [PublishedListeningBlockResult, PublishedListeningBlockResult];
};

export type ListeningStorageAuditIssue = {
  type:
    | 'record_without_file'
    | 'file_without_record'
    | 'stale_staging'
    | 'published_file_without_published_episode'
    | 'duplicate_asset_for_block_version'
    | 'hash_mismatch'
    | 'invalid_path'
    | 'empty_file';
  path?: string;
  episodeId?: string;
  blockId?: string;
  details: string;
};

export type ListeningStorageAuditResult = {
  auditedAt: string;
  issues: ListeningStorageAuditIssue[];
  summary: {
    totalIssues: number;
    recordsWithoutFiles: number;
    filesWithoutRecords: number;
    staleStagingPaths: number;
    hashMismatches: number;
    emptyFiles: number;
  };
};

export const LISTENING_ERRORS = {
  EPISODE_NOT_FOUND:           'LISTENING_EPISODE_NOT_FOUND',
  EPISODE_NOT_READY:           'LISTENING_EPISODE_NOT_READY_FOR_PUBLICATION',
  EPISODE_ALREADY_PUBLISHED:   'LISTENING_EPISODE_ALREADY_PUBLISHED',
  VALIDATION_FAILED:           'LISTENING_PUBLICATION_VALIDATION_FAILED',
  HASH_MISMATCH:               'LISTENING_PUBLICATION_HASH_MISMATCH',
  AUDIO_MISSING:               'LISTENING_PUBLICATION_AUDIO_MISSING',
  TIMING_INVALID:              'LISTENING_PUBLICATION_TIMING_INVALID',
  QUESTION_INVALID:            'LISTENING_PUBLICATION_QUESTION_INVALID',
  SUBTITLE_INVALID:            'LISTENING_PUBLICATION_SUBTITLE_INVALID',
  STORAGE_COPY_FAILED:         'LISTENING_STORAGE_COPY_FAILED',
  STORAGE_FINAL_FILE_INVALID:  'LISTENING_STORAGE_FINAL_FILE_INVALID',
  STORAGE_PATH_CONFLICT:       'LISTENING_STORAGE_PATH_CONFLICT',
  STORAGE_CLEANUP_FAILED:      'LISTENING_STORAGE_CLEANUP_FAILED',
  PERSISTENCE_ERROR:           'LISTENING_PUBLICATION_PERSISTENCE_ERROR',
  ACCESS_DENIED:               'LISTENING_ACCESS_DENIED',
  SIGNED_URL_FAILED:           'LISTENING_SIGNED_URL_FAILED',
  EPISODE_ARCHIVED:            'LISTENING_EPISODE_ARCHIVED',
  PUBLISHED_EPISODE_IMMUTABLE: 'LISTENING_PUBLISHED_EPISODE_IMMUTABLE',
} as const;

export type ListeningErrorCode = typeof LISTENING_ERRORS[keyof typeof LISTENING_ERRORS];

export class ListeningPublicationError extends Error {
  constructor(
    public readonly code: ListeningErrorCode,
    message: string,
    public readonly episodeId: string,
    public readonly blockId?: string,
    public readonly retryable: boolean = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ListeningPublicationError';
  }
}
