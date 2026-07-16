export type GenerationSessionStatus =
  | 'created'
  | 'identifying_level'
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

export interface GenerationSession {
  id: string;
  userId: string;
  userLevel: string | null;
  localDate: string;
  idempotencyKey: string;
  status: GenerationSessionStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  lockedAt: string | null;
  lockExpiresAt: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartGenerationResult {
  generationSessionId: string;
  status: GenerationSessionStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
}

export interface GenerationStatusResult {
  generationSessionId: string;
  status: GenerationSessionStatus;
  currentStep: string | null;
  progressPercent: number;
  episodeId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
}

export const STEP_LABELS: Record<GenerationSessionStatus, string> = {
  created: 'Iniciando',
  identifying_level: 'Identificando seu nível',
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
  finalizing: 'Finalizando sua atividade',
  ready: 'Pronto',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

export const STEP_PROGRESS: Record<GenerationSessionStatus, number> = {
  created: 0,
  identifying_level: 5,
  generating_block_1: 15,
  validating_block_1: 25,
  generating_block_2: 35,
  validating_block_2: 45,
  generating_questions: 55,
  preparing_description: 60,
  preparing_subtitles: 65,
  generating_audio_block_1: 72,
  generating_audio_block_2: 80,
  validating_duration: 88,
  finalizing: 94,
  ready: 100,
  failed: 0,
  cancelled: 0,
};

export const NEXT_STATUS: Partial<Record<GenerationSessionStatus, GenerationSessionStatus>> = {
  created: 'identifying_level',
  identifying_level: 'generating_block_1',
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

// Terminal statuses (do not advance)
export const TERMINAL_STATUSES: Set<GenerationSessionStatus> = new Set([
  'ready', 'failed', 'cancelled',
]);

// Lock duration per step (milliseconds)
export const STEP_LOCK_MS = 180_000; // 3 minutes per step

export class OnDemandSessionNotFoundError extends Error {
  readonly code = 'ON_DEMAND_SESSION_NOT_FOUND';
  constructor(readonly sessionId: string) {
    super(`Generation session not found: ${sessionId}`);
    this.name = 'OnDemandSessionNotFoundError';
  }
}

export class OnDemandSessionLockedError extends Error {
  readonly code = 'ON_DEMAND_SESSION_LOCKED';
  constructor() {
    super('Generation session is currently locked by another process');
    this.name = 'OnDemandSessionLockedError';
  }
}

export class OnDemandSessionTerminalError extends Error {
  readonly code = 'ON_DEMAND_SESSION_TERMINAL';
  constructor(readonly status: GenerationSessionStatus) {
    super(`Session is in terminal state: ${status}`);
    this.name = 'OnDemandSessionTerminalError';
  }
}

export class OnDemandDurationError extends Error {
  readonly code = 'DURATION_VALIDATION_ERROR';
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'OnDemandDurationError';
  }
}

export function toPublicSessionResult(session: {
  id: string;
  status: GenerationSessionStatus;
  current_step: string | null;
  progress_percent: number;
  episode_id: string | null;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
}): GenerationStatusResult {
  return {
    generationSessionId: session.id,
    status: session.status,
    currentStep: session.current_step,
    progressPercent: session.progress_percent,
    episodeId: session.episode_id,
    errorCode: session.error_code,
    errorMessage: session.error_message,
    retryable: session.retryable,
  };
}
