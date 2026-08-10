/**
 * Shared limits for the INDIVIDUAL-WORD pronunciation training drill (the
 * per-word "re-praticar" mic on the results screen), used by BOTH surfaces:
 *   - PronunciationTrainingView → WordRow          (standalone "Treinar pronúncia")
 *   - PronunciationWordGrid     → PracticeWordRow   (writing-flow evaluation result)
 *
 * These limits apply ONLY to the individual-word drill. They must never be
 * confused with, or applied to, the FULL-TEXT pronunciation evaluation, which
 * keeps its own per-plan recording duration (maxRecordingSeconds) and its own
 * daily/monthly evaluation quotas untouched.
 *
 * No React / DOM / Node imports here on purpose: this module is imported by
 * client components AND by the server route
 * (api/pronunciation-training/[...slug].ts), so it must stay isomorphic.
 */

export const WORD_PRACTICE_MAX_ATTEMPTS = 3;

export const WORD_PRACTICE_MAX_DURATION_SECONDS = 8;
export const WORD_PRACTICE_MAX_DURATION_MS = WORD_PRACTICE_MAX_DURATION_SECONDS * 1000;

/**
 * Which server-owned row the per-word attempt counter is anchored to:
 *   - 'training' → public.pronunciation_training_sessions.id  (standalone drill)
 *   - 'writing'  → public.english_reviews.id (text_version_id) (writing flow)
 * The backend re-verifies that the given ownerId belongs to the caller before
 * counting anything, so a client can never forge a context to reset its count.
 */
export type WordPracticeOwnerType = 'training' | 'writing';

export const WORD_PRACTICE_OWNER_TYPES: readonly WordPracticeOwnerType[] = ['training', 'writing'];

export function isWordPracticeOwnerType(v: unknown): v is WordPracticeOwnerType {
  return v === 'training' || v === 'writing';
}

/**
 * Stable normalization used as the per-word counter key. Lowercases and strips
 * leading/trailing non-alphanumerics (keeping inner apostrophes/hyphens), so
 * "Chocolate", "chocolate," and "chocolate" all collapse to the same counter.
 * The server mirrors this exact rule in SQL (register_word_practice_attempt),
 * so the same displayed word always maps to the same row on both sides.
 */
export function normalizeWordForPractice(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .trim();
}

/**
 * User-facing attempt counter label. While attempts remain, it names the
 * attempt the user is about to make ("Tentativa 2 de 3"); once all attempts
 * are spent it states the exhausted state.
 */
export function wordPracticeAttemptLabel(attemptsUsed: number): string {
  if (attemptsUsed >= WORD_PRACTICE_MAX_ATTEMPTS) {
    return `${WORD_PRACTICE_MAX_ATTEMPTS} de ${WORD_PRACTICE_MAX_ATTEMPTS} tentativas usadas`;
  }
  const current = Math.min(attemptsUsed + 1, WORD_PRACTICE_MAX_ATTEMPTS);
  return `Tentativa ${current} de ${WORD_PRACTICE_MAX_ATTEMPTS}`;
}

export function wordPracticeAttemptsExhausted(attemptsUsed: number): boolean {
  return attemptsUsed >= WORD_PRACTICE_MAX_ATTEMPTS;
}
