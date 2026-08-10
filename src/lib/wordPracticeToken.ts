import { getAuthHeader } from './apiAuth';
import { apiUrl } from './apiUrl';
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
    attemptsUsed: typeof data.attemptsUsed === 'number' ? data.attemptsUsed : 1,
    maxAttempts: typeof data.maxAttempts === 'number' ? data.maxAttempts : WORD_PRACTICE_MAX_ATTEMPTS,
    maxDurationSeconds: typeof data.maxDurationSeconds === 'number' ? data.maxDurationSeconds : 5,
  };
}
