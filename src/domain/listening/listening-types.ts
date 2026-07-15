import type { CEFRLevel } from '../curriculum/cefr';

export type { CEFRLevel };

// ─── Tipos de pergunta de compreensão auditiva ────────────────────────────────

export type ListeningQuestionType =
  | 'main_idea'
  | 'detail'
  | 'cause'
  | 'sequence'
  | 'intention'
  | 'simple_inference';

export const LISTENING_QUESTION_TYPES: readonly ListeningQuestionType[] = [
  'main_idea',
  'detail',
  'cause',
  'sequence',
  'intention',
  'simple_inference',
] as const;

export type ListeningQuestionDifficulty = 'easy' | 'appropriate' | 'hard';

export const LISTENING_QUESTION_DIFFICULTIES: readonly ListeningQuestionDifficulty[] = [
  'easy',
  'appropriate',
  'hard',
] as const;

export type ListeningQuestionValidationStatus = 'pending' | 'valid' | 'invalid' | 'needs_review';

export const LISTENING_QUESTION_VALIDATION_STATUSES: readonly ListeningQuestionValidationStatus[] = [
  'pending',
  'valid',
  'invalid',
  'needs_review',
] as const;

export type ListeningEpisodeQuestionsStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type ListeningEpisodeSubtitlesStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type ListeningEpisodeSsmlStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type ListeningEpisodeAudioStatus = 'pending' | 'processing' | 'ready' | 'partial' | 'failed';

export type ListeningBlockAudioStatus = 'pending' | 'processing' | 'uploaded' | 'validated' | 'failed';

export type ListeningTimingSource = 'word_boundaries' | 'sentence_bookmarks' | 'hybrid' | 'fallback';

export type ListeningTimingStatus = 'pending' | 'processing' | 'ready' | 'needs_review' | 'failed';

export type ListeningSubtitleStatus = 'text_ready' | 'timing_pending' | 'timed' | 'failed';

export type ListeningEpisodeStatus =
  | 'draft'
  | 'content_ready'
  | 'audio_processing'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'archived';

export const LISTENING_EPISODE_STATUSES: readonly ListeningEpisodeStatus[] = [
  'draft',
  'content_ready',
  'audio_processing',
  'ready',
  'publishing',
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
  locale: string | null;
  publishedAt: string | null;
  publicationVersion: number;
  publishedBy: string | null;
  publicationSource: 'admin' | 'system' | 'script' | null;
  accessTier: 'free' | 'premium' | 'all';
  questionsStatus: ListeningEpisodeQuestionsStatus | null;
  questionsGeneratedAt: string | null;
  subtitlesStatus: ListeningEpisodeSubtitlesStatus | null;
  subtitlesGeneratedAt: string | null;
  subtitlePromptVersion: string | null;
  subtitleValidatorPromptVersion: string | null;
  ssmlStatus: ListeningEpisodeSsmlStatus | null;
  ssmlGeneratedAt: string | null;
  ssmlGeneratorVersion: string | null;
  audioStatus: ListeningEpisodeAudioStatus | null;
  timingStatus: ListeningTimingStatus | null;
  timingGeneratedAt: string | null;
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
  ssmlStatus: ListeningEpisodeSsmlStatus | null;
  ssmlVersion: number | null;
  ssmlGeneratorVersion: string | null;
  ssmlGeneratedAt: string | null;
  ssmlContentHash: string | null;
  audioStatus: ListeningBlockAudioStatus | null;
  audioAssetId: string | null;
  audioPath: string | null;
  durationMs: number | null;
  timingStatus: ListeningTimingStatus | null;
  timingGeneratedAt: string | null;
  status: ListeningBlockStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListeningSubtitleCue {
  id: string;
  blockId: string;
  language: ListeningSubtitleLanguage;
  cueKey: string | null;
  cueOrder: number;
  sourceSentenceKeys: string[] | null;
  text: string;
  /** Null before audio synthesis; set by the TTS pipeline. */
  startMs: number | null;
  /** Null before audio synthesis; set by the TTS pipeline. */
  endMs: number | null;
  status: ListeningSubtitleStatus | null;
  contentVersion: number | null;
  timingSource: ListeningTimingSource | null;
  timingConfidence: number | null;
  /** Legacy single-key field — kept for backwards compatibility. */
  sentenceKey: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** Draft cue produced by the subtitle preparation pipeline before audio. */
export interface ListeningSubtitleCueDraft {
  cueKey: string;
  cueOrder: number;
  blockOrder: 1 | 2;
  sourceSentenceKeys: string[];
  text: string;
  language: ListeningSubtitleLanguage;
  startMs: null;
  endMs: null;
  status: 'timing_pending';
  contentVersion: number;
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
  questionType: ListeningQuestionType | null;
  difficulty: ListeningQuestionDifficulty | null;
  /** Chaves das frases que comprovam a resposta. Nunca expor ao frontend. */
  evidenceSentenceKeys: string[] | null;
  validationStatus: ListeningQuestionValidationStatus | null;
  /** Resultado completo do validador de IA. Nunca expor ao frontend. */
  validationNotes: unknown | null;
  generatorPromptVersion: string | null;
  validatorPromptVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Versão pública da pergunta — sem campos privados.
 * Não contém: correctOption, evidenceSentenceKeys, validationNotes,
 * validationStatus, generatorPromptVersion, validatorPromptVersion.
 * A explanationPt é enviada separadamente após o aluno responder.
 */
export interface ListeningQuestionPublic {
  id: string;
  episodeId: string;
  blockId: string;
  questionOrder: 1 | 2;
  prompt: string;
  optionsJson: string[];
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

export type ListeningAudioAssetStatus = 'pending' | 'processing' | 'ready' | 'published' | 'failed';

export interface ListeningAudioAsset {
  id: string;
  episodeId: string;
  blockId: string;
  ssmlHash: string;
  audioHash: string;
  stagingPath: string | null;
  publishedPath: string | null;
  fileSizeBytes: number | null;
  durationMs: number | null;
  contentType: string;
  status: ListeningAudioAssetStatus;
  createdAt: string;
  updatedAt: string;
}

export type ListeningTimingArtifactStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface ListeningTimingArtifact {
  id: string;
  audioAssetId: string;
  blockId: string;
  ssmlHash: string;
  audioHash: string;
  timingHash: string;
  status: ListeningTimingArtifactStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListeningSentence {
  id: string;
  blockId: string;
  sentenceKey: string;
  sentenceOrder: number;
  paragraphOrder: number;
  speaker: string | null;
  textEn: string;
  createdAt: string;
}
