import type { CEFRLevel } from '../../../domain/curriculum/cefr';

// ── Job type constants ────────────────────────────────────────────────────────

export const LISTENING_JOB_TYPES = {
  ENSURE_LISTENING_INVENTORY:       'ENSURE_LISTENING_INVENTORY',
  GENERATE_LISTENING_STORY:         'GENERATE_LISTENING_STORY',
  GENERATE_LISTENING_QUESTIONS:     'GENERATE_LISTENING_QUESTIONS',
  PREPARE_LISTENING_SUBTITLES:      'PREPARE_LISTENING_SUBTITLES',
  GENERATE_LISTENING_SSML:          'GENERATE_LISTENING_SSML',
  SYNTHESIZE_LISTENING_BLOCK_AUDIO: 'SYNTHESIZE_LISTENING_BLOCK_AUDIO',
  SYNCHRONIZE_LISTENING_BLOCK:      'SYNCHRONIZE_LISTENING_BLOCK',
  VALIDATE_LISTENING_EPISODE:       'VALIDATE_LISTENING_EPISODE',
  PUBLISH_LISTENING_EPISODE:        'PUBLISH_LISTENING_EPISODE',
  REPAIR_LISTENING_EPISODE:         'REPAIR_LISTENING_EPISODE',
  AUDIT_LISTENING_INVENTORY:        'AUDIT_LISTENING_INVENTORY',
  AUDIT_LISTENING_STORAGE:          'AUDIT_LISTENING_STORAGE',
  CLEANUP_LISTENING_STAGING:          'CLEANUP_LISTENING_STAGING',
  CALCULATE_LISTENING_PERFORMANCE:    'CALCULATE_LISTENING_PERFORMANCE',
} as const;

export type ListeningJobType = typeof LISTENING_JOB_TYPES[keyof typeof LISTENING_JOB_TYPES];

// ── Status constants ──────────────────────────────────────────────────────────

export const LISTENING_JOB_STATUSES = {
  PENDING:     'pending',
  PROCESSING:  'processing',
  RETRY:       'retry',
  COMPLETED:   'completed',
  FAILED:      'failed',
  CANCELLED:   'cancelled',
  DEAD_LETTER: 'dead_letter',
} as const;

export type ListeningJobStatus = typeof LISTENING_JOB_STATUSES[keyof typeof LISTENING_JOB_STATUSES];

// ── Pipeline source ───────────────────────────────────────────────────────────

export type ListeningPipelineSource = 'manual' | 'inventory_cron' | 'repair' | 'admin';

// ── Payload types (discriminated union) ──────────────────────────────────────

export type EnsureInventoryJobPayload = {
  jobType: 'ENSURE_LISTENING_INVENTORY';
  cefrLevel?: CEFRLevel;
  source?: string;
};

export type GenerateStoryJobPayload = {
  jobType: 'GENERATE_LISTENING_STORY';
  cefrLevel: CEFRLevel;
  theme?: string | null;
  seed?: string | null;
  source: ListeningPipelineSource;
  requiredVocabulary?: string[];
  forbiddenVocabulary?: string[];
};

export type GenerateQuestionsJobPayload = {
  jobType: 'GENERATE_LISTENING_QUESTIONS';
  episodeId: string;
};

export type PrepareSubtitlesJobPayload = {
  jobType: 'PREPARE_LISTENING_SUBTITLES';
  episodeId: string;
};

export type GenerateSsmlJobPayload = {
  jobType: 'GENERATE_LISTENING_SSML';
  episodeId: string;
};

export type SynthesizeBlockAudioJobPayload = {
  jobType: 'SYNTHESIZE_LISTENING_BLOCK_AUDIO';
  episodeId: string;
  blockId: string;
  blockOrder: 1 | 2;
};

export type SynchronizeBlockJobPayload = {
  jobType: 'SYNCHRONIZE_LISTENING_BLOCK';
  episodeId: string;
  blockId: string;
  blockOrder: 1 | 2;
};

export type ValidateEpisodeJobPayload = {
  jobType: 'VALIDATE_LISTENING_EPISODE';
  episodeId: string;
};

export type PublishEpisodeJobPayload = {
  jobType: 'PUBLISH_LISTENING_EPISODE';
  episodeId: string;
};

export type RepairEpisodeJobPayload = {
  jobType: 'REPAIR_LISTENING_EPISODE';
  episodeId: string;
};

export type AuditInventoryJobPayload = {
  jobType: 'AUDIT_LISTENING_INVENTORY';
};

export type AuditStorageJobPayload = {
  jobType: 'AUDIT_LISTENING_STORAGE';
  episodeId?: string;
};

export type CleanupStagingJobPayload = {
  jobType: 'CLEANUP_LISTENING_STAGING';
  episodeId?: string;
};

export type CalculateListeningPerformancePayload = {
  jobType: 'CALCULATE_LISTENING_PERFORMANCE';
  userId: string;
  assignmentId: string;
  episodeId: string;
};

export type ListeningJobPayload =
  | EnsureInventoryJobPayload
  | GenerateStoryJobPayload
  | GenerateQuestionsJobPayload
  | PrepareSubtitlesJobPayload
  | GenerateSsmlJobPayload
  | SynthesizeBlockAudioJobPayload
  | SynchronizeBlockJobPayload
  | ValidateEpisodeJobPayload
  | PublishEpisodeJobPayload
  | RepairEpisodeJobPayload
  | AuditInventoryJobPayload
  | AuditStorageJobPayload
  | CleanupStagingJobPayload
  | CalculateListeningPerformancePayload;

// ── Result ────────────────────────────────────────────────────────────────────

export type ListeningJobResult = Record<string, unknown>;

// ── Job record ────────────────────────────────────────────────────────────────

export type ListeningJob = {
  id: string;
  job_type: ListeningJobType;
  status: ListeningJobStatus;
  priority: number;
  episode_id: string | null;
  block_id: string | null;
  cefr_level: string | null;
  payload: ListeningJobPayload;
  result: ListeningJobResult | null;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  next_attempt_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

// ── Handler ───────────────────────────────────────────────────────────────────

export type ListeningJobContext = {
  job: ListeningJob;
  workerId: string;
  heartbeat: () => Promise<boolean>;
};

export type ListeningJobHandlerFn = (ctx: ListeningJobContext) => Promise<ListeningJobResult>;

// ── Error ─────────────────────────────────────────────────────────────────────

export class ListeningJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ListeningJobError';
  }
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export type ListeningInventoryLevelStatus = {
  cefrLevel: string;
  activeUserCount: number;
  publishedAvailable: number;
  inPipeline: number;
  failed: number;
  minimumTarget: number;
  desiredTarget: number;
  missingCount: number;
  status: 'healthy' | 'low' | 'critical' | 'empty';
};

// ── Alert ─────────────────────────────────────────────────────────────────────

export type ListeningOperationalAlert = {
  id: string;
  alert_type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  episode_id: string | null;
  job_id: string | null;
  message: string;
  details: Record<string, unknown> | null;
  status: 'open' | 'acknowledged' | 'resolved';
  created_at: string;
  resolved_at: string | null;
};
