import type {
  ListeningEpisode,
  ListeningBlock,
  ListeningSubtitleCue,
  ListeningQuestion,
  UserListeningProgress,
  ListeningActivityBlock,
  ListeningActivity,
} from './listening-types';
import { toPublicListeningQuestion } from './listening-domain';

export const FIXTURE_EPISODE_ID   = 'e1000000-0000-0000-0000-000000000001';
export const FIXTURE_BLOCK_1_ID   = 'b1000000-0000-0000-0000-000000000001';
export const FIXTURE_BLOCK_2_ID   = 'b1000000-0000-0000-0000-000000000002';
export const FIXTURE_QUESTION_1_ID = 'q1000000-0000-0000-0000-000000000001';
export const FIXTURE_QUESTION_2_ID = 'q1000000-0000-0000-0000-000000000002';
export const FIXTURE_USER_ID       = 'u1000000-0000-0000-0000-000000000001';

// Episódio de desenvolvimento — nunca publicado em produção.
export const fixtureEpisode: ListeningEpisode = {
  id: FIXTURE_EPISODE_ID,
  title: '[TEST] Daily Commute',
  synopsis: null,
  cefrLevel: 'B1',
  status: 'draft',
  contentVersion: 1,
  estimatedDurationSeconds: 600,
  actualDurationSeconds: null,
  voiceName: null,
  publishedAt: null,
  createdAt: '2026-07-15T08:00:00Z',
  updatedAt: '2026-07-15T08:00:00Z',
};

export const fixtureBlock1: ListeningBlock = {
  id: FIXTURE_BLOCK_1_ID,
  episodeId: FIXTURE_EPISODE_ID,
  blockOrder: 1,
  textEn: 'Sarah takes the bus every morning. She reads a book during the trip.',
  translationPt: null,
  ssml: null,
  audioPath: null,
  durationMs: null,
  status: 'draft',
  createdAt: '2026-07-15T08:00:00Z',
  updatedAt: '2026-07-15T08:00:00Z',
};

export const fixtureBlock2: ListeningBlock = {
  id: FIXTURE_BLOCK_2_ID,
  episodeId: FIXTURE_EPISODE_ID,
  blockOrder: 2,
  textEn: 'When she arrives at the office, she makes coffee. Then she starts working.',
  translationPt: null,
  ssml: null,
  audioPath: null,
  durationMs: null,
  status: 'draft',
  createdAt: '2026-07-15T08:00:00Z',
  updatedAt: '2026-07-15T08:00:00Z',
};

export const fixtureQuestion1: ListeningQuestion = {
  id: FIXTURE_QUESTION_1_ID,
  episodeId: FIXTURE_EPISODE_ID,
  blockId: FIXTURE_BLOCK_1_ID,
  questionOrder: 1,
  prompt: 'What does Sarah do during the bus trip?',
  optionsJson: [
    'She listens to music',
    'She reads a book',
    'She sleeps',
    'She talks to friends',
  ],
  correctOption: 1,
  explanationPt: 'O texto diz que Sarah lê um livro durante a viagem de ônibus.',
  maxAttempts: 3,
  createdAt: '2026-07-15T08:00:00Z',
  updatedAt: '2026-07-15T08:00:00Z',
};

export const fixtureQuestion2: ListeningQuestion = {
  id: FIXTURE_QUESTION_2_ID,
  episodeId: FIXTURE_EPISODE_ID,
  blockId: FIXTURE_BLOCK_2_ID,
  questionOrder: 2,
  prompt: 'What is the first thing Sarah does when she arrives at the office?',
  optionsJson: [
    'She starts working',
    'She checks her email',
    'She makes coffee',
    'She calls a friend',
  ],
  correctOption: 2,
  explanationPt: 'O texto diz que Sarah faz café assim que chega ao escritório.',
  maxAttempts: 3,
  createdAt: '2026-07-15T08:00:00Z',
  updatedAt: '2026-07-15T08:00:00Z',
};

export const fixtureSubtitlesEnBlock1: ListeningSubtitleCue[] = [
  {
    id: 'cue-en-b1-1',
    blockId: FIXTURE_BLOCK_1_ID,
    language: 'en',
    cueOrder: 1,
    startMs: 0,
    endMs: 3000,
    text: 'Sarah takes the bus every morning.',
    sentenceKey: 'block1.sent1',
    createdAt: '2026-07-15T08:00:00Z',
  },
  {
    id: 'cue-en-b1-2',
    blockId: FIXTURE_BLOCK_1_ID,
    language: 'en',
    cueOrder: 2,
    startMs: 3200,
    endMs: 6500,
    text: 'She reads a book during the trip.',
    sentenceKey: 'block1.sent2',
    createdAt: '2026-07-15T08:00:00Z',
  },
];

export const fixtureSubtitlesPtBlock1: ListeningSubtitleCue[] = [
  {
    id: 'cue-pt-b1-1',
    blockId: FIXTURE_BLOCK_1_ID,
    language: 'pt-BR',
    cueOrder: 1,
    startMs: 0,
    endMs: 3000,
    text: 'Sarah pega o ônibus toda manhã.',
    sentenceKey: 'block1.sent1',
    createdAt: '2026-07-15T08:00:00Z',
  },
  {
    id: 'cue-pt-b1-2',
    blockId: FIXTURE_BLOCK_1_ID,
    language: 'pt-BR',
    cueOrder: 2,
    startMs: 3200,
    endMs: 6500,
    text: 'Ela lê um livro durante a viagem.',
    sentenceKey: 'block1.sent2',
    createdAt: '2026-07-15T08:00:00Z',
  },
];

export const fixtureSubtitlesEnBlock2: ListeningSubtitleCue[] = [
  {
    id: 'cue-en-b2-1',
    blockId: FIXTURE_BLOCK_2_ID,
    language: 'en',
    cueOrder: 1,
    startMs: 0,
    endMs: 3500,
    text: 'When she arrives at the office, she makes coffee.',
    sentenceKey: 'block2.sent1',
    createdAt: '2026-07-15T08:00:00Z',
  },
  {
    id: 'cue-en-b2-2',
    blockId: FIXTURE_BLOCK_2_ID,
    language: 'en',
    cueOrder: 2,
    startMs: 3700,
    endMs: 6800,
    text: 'Then she starts working.',
    sentenceKey: 'block2.sent2',
    createdAt: '2026-07-15T08:00:00Z',
  },
];

export const fixtureSubtitlesPtBlock2: ListeningSubtitleCue[] = [
  {
    id: 'cue-pt-b2-1',
    blockId: FIXTURE_BLOCK_2_ID,
    language: 'pt-BR',
    cueOrder: 1,
    startMs: 0,
    endMs: 3500,
    text: 'Quando ela chega ao escritório, ela faz café.',
    sentenceKey: 'block2.sent1',
    createdAt: '2026-07-15T08:00:00Z',
  },
  {
    id: 'cue-pt-b2-2',
    blockId: FIXTURE_BLOCK_2_ID,
    language: 'pt-BR',
    cueOrder: 2,
    startMs: 3700,
    endMs: 6800,
    text: 'Depois ela começa a trabalhar.',
    sentenceKey: 'block2.sent2',
    createdAt: '2026-07-15T08:00:00Z',
  },
];

export function makeActivityBlock(
  block: ListeningBlock,
  question: ListeningQuestion,
  subtitlesEn: ListeningSubtitleCue[],
  subtitlesPt: ListeningSubtitleCue[]
): ListeningActivityBlock {
  return {
    block,
    question: toPublicListeningQuestion(question),
    subtitlesEn,
    subtitlesPt,
  };
}

export const fixtureActivity: ListeningActivity = {
  episode: fixtureEpisode,
  blocks: [
    makeActivityBlock(fixtureBlock1, fixtureQuestion1, fixtureSubtitlesEnBlock1, fixtureSubtitlesPtBlock1),
    makeActivityBlock(fixtureBlock2, fixtureQuestion2, fixtureSubtitlesEnBlock2, fixtureSubtitlesPtBlock2),
  ],
  progress: null,
};

export function makeProgress(overrides: Partial<UserListeningProgress> = {}): UserListeningProgress {
  return {
    id: 'prog-0000-0000-0000-000000000001',
    userId: FIXTURE_USER_ID,
    episodeId: FIXTURE_EPISODE_ID,
    status: 'not_started',
    currentBlock: 1,
    block1CompletedAt: null,
    block1CorrectAttempt: null,
    block2CompletedAt: null,
    block2CorrectAttempt: null,
    completedAt: null,
    createdAt: '2026-07-15T08:00:00Z',
    updatedAt: '2026-07-15T08:00:00Z',
    ...overrides,
  };
}
