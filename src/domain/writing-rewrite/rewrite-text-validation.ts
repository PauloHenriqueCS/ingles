/**
 * Pure, deterministic "is this even worth sending to the AI" gate for a V2
 * rewrite submission. No external dependencies — importable from both the
 * browser bundle (RewriteSection.tsx, so a garbage submission never reaches
 * the network) and the backend (writing-rewrite-evaluate.ts / compare-rewrite.ts,
 * the authoritative check — the frontend one is UX only, never trusted alone).
 *
 * This is NOT a spell-checker or a language detector — it only rejects the
 * unambiguous cases (empty, a single run-on token, mostly digits/symbols,
 * mostly consonant strings with no vowels) that a genuine attempt at an
 * English sentence never produces. A real, short, imperfect A1 sentence
 * ("I like cats.") must always pass — see MIN_WORD_COUNT below.
 */

export type RewriteTextValidationReason =
  | 'EMPTY'
  | 'TOO_FEW_WORDS'
  | 'NOT_ENGLISH_LIKE';

export interface RewriteTextValidationResult {
  valid: boolean;
  reasonCode?: RewriteTextValidationReason;
  /** User-facing, pt-BR, non-technical — safe to render as-is. */
  message?: string;
}

// Deliberately low — a legitimate A1 sentence ("I like cats.") is 3 words.
// This gate exists to catch "5eysvduduud", not to enforce essay length.
const MIN_WORD_COUNT = 3;
const MIN_ALPHA_CHAR_RATIO = 0.75;
const MIN_WORD_LIKE_RATIO = 0.6;

const VOWEL_RE = /[aeiouAEIOUyY]/;
const CONSECUTIVE_CONSONANTS_RE = /[^aeiouAEIOU\s]{5,}/;

export const INVALID_REWRITE_TEXT_MESSAGE =
  'Sua versão 2 não parece um texto em inglês válido. Escreva frases completas usando palavras reais, corrigindo os erros apontados.';

/** A token counts as "word-like" if it has a vowel and no implausible consonant run — cheap, not a dictionary lookup. */
function isWordLike(token: string): boolean {
  const clean = token.replace(/[^a-zA-Z']/g, '');
  if (clean.length === 0) return false;
  if (!VOWEL_RE.test(clean)) return false;
  if (CONSECUTIVE_CONSONANTS_RE.test(clean)) return false;
  return true;
}

export function validateRewriteText(text: string): RewriteTextValidationResult {
  const trimmed = (text ?? '').trim();

  if (!trimmed) {
    return { valid: false, reasonCode: 'EMPTY', message: 'Escreva sua versão 2 antes de comparar.' };
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORD_COUNT) {
    return { valid: false, reasonCode: 'TOO_FEW_WORDS', message: INVALID_REWRITE_TEXT_MESSAGE };
  }

  const noSpace = trimmed.replace(/\s+/g, '');
  const alphaCount = (noSpace.match(/[a-zA-Z]/g) ?? []).length;
  if (noSpace.length === 0 || alphaCount / noSpace.length < MIN_ALPHA_CHAR_RATIO) {
    return { valid: false, reasonCode: 'NOT_ENGLISH_LIKE', message: INVALID_REWRITE_TEXT_MESSAGE };
  }

  const wordLikeCount = words.filter(isWordLike).length;
  if (wordLikeCount / words.length < MIN_WORD_LIKE_RATIO) {
    return { valid: false, reasonCode: 'NOT_ENGLISH_LIKE', message: INVALID_REWRITE_TEXT_MESSAGE };
  }

  return { valid: true };
}
