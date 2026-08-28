import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
import { fileToBase64 } from './base64Audio';
import type { PronunciationNormalizedResult, PronunciationFailCode } from '../types';
import {
  WORD_PRACTICE_MAX_ATTEMPTS,
  type WordPracticeOwnerType,
} from '../domain/pronunciation/word-practice-limits';

/**
 * Shared client helper for the INDIVIDUAL-WORD training drill token request.
 * Both surfaces (WordRow in PronunciationTrainingView and PracticeWordRow in
 * PronunciationWordGrid) call this. The server (/api/pronunciation-training/
 * token) registers one per-word attempt and enforces the 3-attempt cap BEFORE
 * issuing the Azure token, so this is also where the client learns the
 * authoritative attempt count and the exhausted state.
 */

export interface WordPracticeTokenResult {
  token: string;
  region: string;
  /** Data-driven Azure recognition locale for the learning language (e.g. 'en-US'). */
  language: string;
  attemptsUsed: number;
  maxAttempts: number;
  maxDurationSeconds: number;
}

/** Thrown when the server rejects a 4th (or later) attempt for the word. */
export class WordAttemptLimitError extends Error {
  constructor(public readonly attemptsUsed: number) {
    super('WORD_ATTEMPT_LIMIT_REACHED');
    this.name = 'WordAttemptLimitError';
  }
}

export async function fetchWordPracticeToken(
  word: string,
  ownerType: WordPracticeOwnerType,
  ownerId: string,
): Promise<WordPracticeTokenResult> {
  const headers = await getAuthHeader();
  const resp = await fetch(apiUrl('/api/pronunciation-training/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ word, ownerType, ownerId }),
  });

  if (resp.status === 429) {
    const j = (await resp.json().catch(() => ({}))) as { attemptsUsed?: number };
    throw new WordAttemptLimitError(
      typeof j.attemptsUsed === 'number' ? j.attemptsUsed : WORD_PRACTICE_MAX_ATTEMPTS,
    );
  }
  if (!resp.ok) {
    const j = (await resp.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message ?? 'Token unavailable');
  }

  const data = (await resp.json()) as Partial<WordPracticeTokenResult>;
  return {
    token: String(data.token ?? ''),
    region: String(data.region ?? ''),
    // Recognition locale resolved server-side from the learning language. Absent
    // only for an older server; the session helper then lets Azure auto-detect
    // rather than forcing English (no hardcoded en-US client fallback).
    language: typeof data.language === 'string' && data.language ? data.language : '',
    attemptsUsed: typeof data.attemptsUsed === 'number' ? data.attemptsUsed : 1,
    maxAttempts: typeof data.maxAttempts === 'number' ? data.maxAttempts : WORD_PRACTICE_MAX_ATTEMPTS,
    maxDurationSeconds: typeof data.maxDurationSeconds === 'number' ? data.maxDurationSeconds : 5,
  };
}

/** Thrown for a provider/audio failure so the caller can show the message and
 *  NOT consume the attempt (the server already refunded it). */
export class WordAssessError extends Error {
  constructor(
    public readonly code: PronunciationFailCode | 'UNKNOWN',
    message: string,
    public readonly attemptsUsed: number,
  ) {
    super(message);
    this.name = 'WordAssessError';
  }
}

export interface WordAssessResult {
  result: PronunciationNormalizedResult;
  attemptsUsed: number;
  maxAttempts: number;
}

/**
 * SERVER-SIDE per-word assessment for the individual-word drill (both surfaces).
 * Uploads the WAV the recorder already produced to /api/pronunciation-training/
 * word-assess, where the attempt is registered (3/word cap) and Azure runs the
 * assessment — the browser no longer opens a WebSocket that could stall with
 * zero SDK events ("Análise demorou"). Returns the same normalized result the
 * client used to compute locally, so buildWordAlignment() is unchanged.
 *
 * Throws WordAttemptLimitError when the cap is reached, WordAssessError for a
 * provider/audio failure (attempt already refunded server-side).
 */
export async function assessWord(
  word: string,
  ownerType: WordPracticeOwnerType,
  ownerId: string,
  wavFile: Blob,
): Promise<WordAssessResult> {
  const audioBase64 = await fileToBase64(wavFile);
  const headers = await getAuthHeader();
  const resp = await fetch(apiUrl('/api/pronunciation-training/word-assess'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ word, ownerType, ownerId, audioBase64 }),
  });

  const json = (await resp.json().catch(() => ({}))) as {
    code?: string; message?: string; attemptsUsed?: number; maxAttempts?: number;
    result?: PronunciationNormalizedResult;
  };

  if (resp.status === 429 || json.code === 'WORD_ATTEMPT_LIMIT_REACHED') {
    throw new WordAttemptLimitError(
      typeof json.attemptsUsed === 'number' ? json.attemptsUsed : WORD_PRACTICE_MAX_ATTEMPTS,
    );
  }
  if (!resp.ok || !json.result) {
    throw new WordAssessError(
      (json.code as PronunciationFailCode | undefined) ?? 'UNKNOWN',
      json.message ?? 'Erro. Tente novamente.',
      typeof json.attemptsUsed === 'number' ? json.attemptsUsed : 0,
    );
  }

  return {
    result: json.result,
    attemptsUsed: typeof json.attemptsUsed === 'number' ? json.attemptsUsed : 1,
    maxAttempts: typeof json.maxAttempts === 'number' ? json.maxAttempts : WORD_PRACTICE_MAX_ATTEMPTS,
  };
}
