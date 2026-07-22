import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningLevelGroup } from '../listening-level-group';

export type GroupGenerationStatus =
  | 'created'
  | 'generating_block_1'
  | 'validating_block_1'
  | 'generating_block_2'
  | 'validating_block_2'
  | 'generating_questions'
  | 'preparing_description'
  | 'preparing_subtitles'
  | 'generating_audio_block_1'
  | 'generating_audio_block_2'
  | 'validating_duration'
  | 'finalizing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface ListeningGenerationJob {
  id: string;
  levelGroup: ListeningLevelGroup;
  targetLevel: CEFRLevel;
  idempotencyKey: string;
  status: GroupGenerationStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  lockExpiresAt: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const STEP_LABELS: Record<GroupGenerationStatus, string> = {
  created: 'Iniciando',
  generating_block_1: 'Criando a primeira parte da história',
  validating_block_1: 'Validando a primeira parte',
  generating_block_2: 'Criando a segunda parte da história',
  validating_block_2: 'Validando a segunda parte',
  generating_questions: 'Criando as perguntas',
  preparing_description: 'Preparando a descrição',
  preparing_subtitles: 'Preparando as legendas',
  generating_audio_block_1: 'Gerando o primeiro áudio',
  generating_audio_block_2: 'Gerando o segundo áudio',
  validating_duration: 'Validando a duração',
  finalizing: 'Finalizando o conteúdo compartilhado',
  ready: 'Pronto',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

export const STEP_PROGRESS: Record<GroupGenerationStatus, number> = {
  created: 0,
  generating_block_1: 10,
  validating_block_1: 20,
  generating_block_2: 30,
  validating_block_2: 40,
  generating_questions: 50,
  preparing_description: 57,
  preparing_subtitles: 64,
  generating_audio_block_1: 73,
  generating_audio_block_2: 82,
  validating_duration: 90,
  finalizing: 96,
  ready: 100,
  failed: 0,
  cancelled: 0,
};

export const NEXT_STATUS: Partial<Record<GroupGenerationStatus, GroupGenerationStatus>> = {
  created: 'generating_block_1',
  generating_block_1: 'validating_block_1',
  validating_block_1: 'generating_block_2',
  generating_block_2: 'validating_block_2',
  validating_block_2: 'generating_questions',
  generating_questions: 'preparing_description',
  preparing_description: 'preparing_subtitles',
  preparing_subtitles: 'generating_audio_block_1',
  generating_audio_block_1: 'generating_audio_block_2',
  generating_audio_block_2: 'validating_duration',
  validating_duration: 'finalizing',
  finalizing: 'ready',
};

/**
 * Statuses that do NOT hold the database-backed lock on a level_group.
 * Must match the `WHERE status NOT IN (...)` predicate on
 * uq_listening_generation_jobs_active_group in the migration: a completed
 * job ('ready') is deliberately excluded so it does not block the next
 * alternated generation for the group, and 'failed'/'cancelled' jobs must
 * never block retries.
 */
export const NON_BLOCKING_STATUSES: ReadonlySet<GroupGenerationStatus> = new Set([
  'ready', 'failed', 'cancelled',
]);

export const TERMINAL_STATUSES: ReadonlySet<GroupGenerationStatus> = new Set([
  'ready', 'failed', 'cancelled',
]);

// Lock duration per step (milliseconds) — same budget as the on-demand pipeline.
export const STEP_LOCK_MS = 180_000;

export class GroupJobNotFoundError extends Error {
  readonly code = 'LISTENING_GROUP_JOB_NOT_FOUND';
  constructor(readonly jobId: string) {
    super(`Listening group generation job not found: ${jobId}`);
    this.name = 'GroupJobNotFoundError';
  }
}

export class GroupJobLockedError extends Error {
  readonly code = 'LISTENING_GROUP_JOB_LOCKED';
  constructor() {
    super('Listening group generation job is currently locked by another process');
    this.name = 'GroupJobLockedError';
  }
}

export class GroupJobTerminalError extends Error {
  readonly code = 'LISTENING_GROUP_JOB_TERMINAL';
  constructor(readonly status: GroupGenerationStatus) {
    super(`Listening group generation job is in terminal state: ${status}`);
    this.name = 'GroupJobTerminalError';
  }
}

export class GroupJobDurationError extends Error {
  readonly code = 'DURATION_VALIDATION_ERROR';
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'GroupJobDurationError';
  }
}

export interface GroupGenerationStatusResult {
  jobId: string;
  levelGroup: ListeningLevelGroup;
  targetLevel: CEFRLevel;
  status: GroupGenerationStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
}

export function toPublicGroupJobResult(row: {
  id: string;
  level_group: string;
  target_level: string;
  status: string;
  current_step: string | null;
  progress_percent: number;
  episode_id: string | null;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
}): GroupGenerationStatusResult {
  return {
    jobId: row.id,
    levelGroup: row.level_group as ListeningLevelGroup,
    targetLevel: row.target_level as CEFRLevel,
    status: row.status as GroupGenerationStatus,
    currentStep: row.current_step,
    progressPercent: row.progress_percent,
    episodeId: row.episode_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable,
  };
}

export function rowToListeningGenerationJob(row: {
  id: string;
  level_group: string;
  target_level: string;
  idempotency_key: string;
  status: string;
  current_step: string | null;
  progress_percent: number;
  episode_id: string | null;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}): ListeningGenerationJob {
  return {
    id: row.id,
    levelGroup: row.level_group as ListeningLevelGroup,
    targetLevel: row.target_level as CEFRLevel,
    idempotencyKey: row.idempotency_key,
    status: row.status as GroupGenerationStatus,
    currentStep: row.current_step,
    progressPercent: row.progress_percent,
    episodeId: row.episode_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lockExpiresAt: row.lock_expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
