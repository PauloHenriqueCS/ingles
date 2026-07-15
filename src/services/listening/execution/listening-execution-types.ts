export type ListeningBlockSessionStatus =
  | 'active'
  | 'awaiting_answer'
  | 'replay_required'
  | 'completed'
  | 'abandoned'
  | 'expired';

export interface ListeningBlockSession {
  id: string;
  userId: string;
  episodeId: string;
  blockId: string;
  questionId: string;
  attemptCycle: number;
  currentAttempt: 1 | 2 | 3;
  status: ListeningBlockSessionStatus;
  startedAt: string;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicSubtitleCue = {
  cueKey: string;
  cueOrder: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type SessionAudioInfo = {
  url: string;
  expiresAt: string;
  durationMs: number;
};

export type SessionQuestionInfo = {
  id: string;
  prompt: string;
  options: string[];
  maxAttempts: 3;
};

export type SessionInfo = {
  sessionId: string;
  attemptCycle: number;
  currentAttempt: 1 | 2 | 3;
  subtitleMode: 'none' | 'en' | 'pt-BR';
  status: ListeningBlockSessionStatus;
  expiresAt: string;
};

export type SessionBlockInfo = {
  blockId: string;
  blockOrder: 1 | 2;
  locked: boolean;
  completed: boolean;
  durationMs: number;
  session: SessionInfo | null;
  audio: SessionAudioInfo | null;
  question: SessionQuestionInfo | null;
  subtitles: { en: PublicSubtitleCue[]; ptBr: PublicSubtitleCue[] } | null;
};

export type EpisodeSessionResponse = {
  episodeId: string;
  title: string;
  cefrLevel: string;
  estimatedDurationSeconds: number;
  actualDurationSeconds: number | null;
  progress: {
    status: string;
    block1CompletedAt: string | null;
    block2CompletedAt: string | null;
    completedAt: string | null;
  } | null;
  blocks: [SessionBlockInfo, SessionBlockInfo];
};

export type SubmitAnswerResult = {
  correct: boolean;
  attemptNumber: 1 | 2 | 3;
  sessionStatus: ListeningBlockSessionStatus;
  nextAttempt: 1 | 2 | 3 | null;
  nextSubtitleMode: 'none' | 'en' | 'pt-BR' | null;
  /** Returned on correct answer OR on cycle failure (session abandoned). Never on wrong mid-cycle. */
  explanationPt: string | null;
  /** Returned only on cycle failure — index of the correct option (0-based). */
  correctOption: number | null;
  blockCompleted: boolean;
  episodeCompleted: boolean;
};

export const LISTENING_EXECUTION_ERRORS = {
  SESSION_NOT_FOUND:         'LISTENING_SESSION_NOT_FOUND',
  SESSION_EXPIRED:           'LISTENING_SESSION_EXPIRED',
  SESSION_WRONG_STATE:       'LISTENING_SESSION_WRONG_STATE',
  BLOCK_LOCKED:              'LISTENING_BLOCK_LOCKED',
  BLOCK_ALREADY_COMPLETED:   'LISTENING_BLOCK_ALREADY_COMPLETED',
  EPISODE_NOT_FOUND:         'LISTENING_EPISODE_NOT_FOUND',
  EPISODE_NOT_PUBLISHED:     'LISTENING_EPISODE_NOT_PUBLISHED',
  QUESTION_NOT_FOUND:        'LISTENING_QUESTION_NOT_FOUND',
  DUPLICATE_SUBMISSION:      'LISTENING_DUPLICATE_SUBMISSION',
  PROGRESS_SAVE_FAILED:      'LISTENING_PROGRESS_SAVE_FAILED',
  SESSION_CONFLICT:          'LISTENING_SESSION_CONFLICT',
  INTERNAL_ERROR:            'LISTENING_INTERNAL_ERROR',
} as const;

export type ListeningExecutionErrorCode =
  typeof LISTENING_EXECUTION_ERRORS[keyof typeof LISTENING_EXECUTION_ERRORS];

export class ListeningExecutionError extends Error {
  constructor(
    public readonly code: ListeningExecutionErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ListeningExecutionError';
  }
}
