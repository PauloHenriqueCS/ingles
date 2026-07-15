import type { CEFRLevel } from '../curriculum/cefr';

export type { CEFRLevel };

export type ListeningEpisodeStatus =
  | 'draft'
  | 'content_ready'
  | 'audio_processing'
  | 'ready'
  | 'published'
  | 'failed'
  | 'archived';

export const LISTENING_EPISODE_STATUSES: readonly ListeningEpisodeStatus[] = [
  'draft',
  'content_ready',
  'audio_processing',
  'ready',
  'published',
  'failed',
  'archived',
] as const;

export type ListeningBlockStatus =
  | 'draft'
  | 'content_ready'
  | 'audio_processing'
  | 'ready'
  | 'failed';

export const LISTENING_BLOCK_STATUSES: readonly ListeningBlockStatus[] = [
  'draft',
  'content_ready',
  'audio_processing',
  'ready',
  'failed',
] as const;

export type ListeningSubtitleLanguage = 'en' | 'pt-BR';

export const LISTENING_SUBTITLE_LANGUAGES: readonly ListeningSubtitleLanguage[] = [
  'en',
  'pt-BR',
] as const;

/** 1, 2, ou 3. Tentativa 4+ reinicia o ciclo (attempt_cycle + 1). */
export type ListeningAttemptNumber = 1 | 2 | 3;

/** none = tentativa 1, en = tentativa 2, pt-BR = tentativa 3. */
export type ListeningSubtitleMode = 'none' | 'en' | 'pt-BR';

export const LISTENING_SUBTITLE_MODES: readonly ListeningSubtitleMode[] = [
  'none',
  'en',
  'pt-BR',
] as const;

export type UserListeningProgressStatus =
  | 'not_started'
  | 'block_1_active'
  | 'block_1_completed'
  | 'block_2_active'
  | 'completed';

export const USER_LISTENING_PROGRESS_STATUSES: readonly UserListeningProgressStatus[] = [
  'not_started',
  'block_1_active',
  'block_1_completed',
  'block_2_active',
  'completed',
] as const;

export interface ListeningEpisode {
  id: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  status: ListeningEpisodeStatus;
  contentVersion: number;
  estimatedDurationSeconds: number | null;
  actualDurationSeconds: number | null;
  voiceName: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListeningBlock {
  id: string;
  episodeId: string;
  blockOrder: 1 | 2;
  textEn: string;
  translationPt: string | null;
  ssml: string | null;
  audioPath: string | null;
  durationMs: number | null;
  status: ListeningBlockStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListeningSubtitleCue {
  id: string;
  blockId: string;
  language: ListeningSubtitleLanguage;
  cueOrder: number;
  startMs: number;
  endMs: number;
  text: string;
  sentenceKey: string | null;
  createdAt: string;
}

export interface ListeningQuestion {
  id: string;
  episodeId: string;
  blockId: string;
  questionOrder: 1 | 2;
  prompt: string;
  optionsJson: string[];
  /** Índice da alternativa correta. Nunca expor ao frontend. */
  correctOption: number;
  explanationPt: string;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/** Versão pública da pergunta — sem correctOption nem campo equivalente. */
export interface ListeningQuestionPublic {
  id: string;
  episodeId: string;
  blockId: string;
  questionOrder: 1 | 2;
  prompt: string;
  optionsJson: string[];
  explanationPt: string;
  maxAttempts: number;
}

export interface UserListeningProgress {
  id: string;
  userId: string;
  episodeId: string;
  status: UserListeningProgressStatus;
  currentBlock: 1 | 2;
  block1CompletedAt: string | null;
  block1CorrectAttempt: 1 | 2 | 3 | null;
  block2CompletedAt: string | null;
  block2CorrectAttempt: 1 | 2 | 3 | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserListeningAttempt {
  id: string;
  userId: string;
  episodeId: string;
  blockId: string;
  questionId: string;
  attemptCycle: number;
  attemptNumber: ListeningAttemptNumber;
  selectedOption: number;
  /** Definido somente pelo backend. O frontend não pode enviar este valor livremente. */
  isCorrect: boolean | null;
  subtitleMode: ListeningSubtitleMode;
  playbackRate: number;
  answeredAt: string;
  createdAt: string;
}

export interface ListeningActivityBlock {
  block: ListeningBlock;
  question: ListeningQuestionPublic;
  subtitlesEn: ListeningSubtitleCue[];
  subtitlesPt: ListeningSubtitleCue[];
}

export interface ListeningActivity {
  episode: ListeningEpisode;
  blocks: ListeningActivityBlock[];
  progress: UserListeningProgress | null;
}
