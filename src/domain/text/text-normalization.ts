/**
 * Shared, pure text-normalization utilities used by every writing-exercise
 * validator (fill-in-the-blank answers, required words/phrases, character
 * counting). Pure functions, no external dependencies.
 *
 * IMPORTANT: these helpers exist ONLY for comparison/counting. They MUST NOT
 * be used to mutate text that is displayed to the user, saved to the database,
 * shown in history, sent to review, or used for pronunciation. The caller
 * always keeps the original, user-typed string intact and normalizes a copy.
 *
 * Unicode form: we use NFC (not NFKC). NFC is canonical composition and is
 * safe for learner text — it merges canonically-equivalent sequences (e.g. a
 * combining-accent form and its precomposed form) without altering meaning.
 * NFKC would additionally collapse compatibility characters (e.g. the fi
 * ligature, full-width letters, superscripts) which can change what the learner
 * actually wrote, so we deliberately avoid it. Curly quotes are *not* folded by
 * NFC, so we fold them explicitly below.
 */

/** Curly/smart apostrophes and quotation marks -> ASCII equivalents. Comparison-only. */
export function foldSmartQuotes(text: string): string {
  return text
    // Apostrophes / single quotes -> '
    .replace(/[‘’‛′`´ʼ]/g, "'")
    // Double quotes -> "
    .replace(/[“”„‟″«»]/g, '"');
}

/**
 * Remove invisible/zero-width formatting characters commonly inserted by mobile
 * keyboards and copy/paste (zero-width space/joiner, BOM, soft hyphen, bidi
 * marks). Normal spaces are preserved (they are handled by whitespace collapse).
 * NBSP (U+00A0) is intentionally NOT stripped here — it is a space and is
 * handled by the `\s+` whitespace collapse in normalizeForComparison.
 */
export function stripInvisibleCharacters(text: string): string {
  return text.replace(/[​-‏­⁠﻿᠎]/g, '');
}

export interface ComparisonOptions {
  /** Strip trailing sentence punctuation (`. ! ?`). Default: true. */
  stripTrailingPunctuation?: boolean;
  /** Expand English contractions to their long form (doesn't -> does not). Default: false. */
  expandContractions?: boolean;
}

/**
 * Canonical comparison normalizer. Applies, in order: NFC, smart-quote folding,
 * invisible-character removal, lowercasing, whitespace collapse + trim, and
 * (optionally) trailing-punctuation stripping and contraction expansion.
 *
 * Note: JS `\s` already matches NBSP and the other Unicode spaces, so collapsing
 * `\s+` also normalizes non-breaking/odd spaces and line breaks to a single space.
 */
export function normalizeForComparison(text: string, options: ComparisonOptions = {}): string {
  const { stripTrailingPunctuation = true, expandContractions: expand = false } = options;

  let result = foldSmartQuotes(text.normalize('NFC'));
  result = stripInvisibleCharacters(result);
  result = result.toLowerCase();
  result = result.replace(/\s+/g, ' ').trim();

  if (expand) {
    result = expandContractions(result);
    // Contraction expansion can introduce new spacing; re-collapse.
    result = result.replace(/\s+/g, ' ').trim();
  }

  if (stripTrailingPunctuation) {
    // Only trailing sentence punctuation that is not part of the graded content.
    result = result.replace(/[.!?]+$/g, '').trim();
  }

  return result;
}

/**
 * Normalization for search/presence checks (required words & phrases): folds
 * quotes, NFC, strips invisibles, lowercases and collapses whitespace, but
 * keeps apostrophes and internal punctuation so that word boundaries remain
 * meaningful. Does NOT expand contractions or strip trailing punctuation.
 */
export function normalizeForSearch(text: string): string {
  return normalizeForComparison(text, { stripTrailingPunctuation: false, expandContractions: false });
}

/**
 * Normalization for exercise-answer equality: also expands contractions so that
 * "He doesn't like it" and "He does not like it." are treated as equivalent.
 */
export function normalizeAnswerForComparison(text: string): string {
  return normalizeForComparison(text, { stripTrailingPunctuation: true, expandContractions: true });
}

/**
 * Canonical English contraction -> long-form map. Keys are lowercase with a
 * straight apostrophe (input is quote-folded and lowercased before expansion).
 * Ambiguous forms (`'s`, `'d`) resolve to the most common reading, matching the
 * pre-existing behavior elsewhere in the codebase. Used to treat grammatically
 * equivalent contractions and their long forms as the same answer.
 */
export const CONTRACTION_EXPANSIONS: Readonly<Record<string, string>> = {
  // Negatives (the equivalences explicitly required by the writing exercises)
  "doesn't": 'does not',
  "don't": 'do not',
  "didn't": 'did not',
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "haven't": 'have not',
  "hasn't": 'has not',
  "hadn't": 'had not',
  "can't": 'cannot',
  "couldn't": 'could not',
  "shouldn't": 'should not',
  "wouldn't": 'would not',
  "won't": 'will not',
  "mustn't": 'must not',
  "mightn't": 'might not',
  "needn't": 'need not',
  "shan't": 'shall not',
  // Pronoun + auxiliary
  "i'm": 'i am',
  "i've": 'i have',
  "i'll": 'i will',
  "i'd": 'i would',
  "you're": 'you are',
  "you've": 'you have',
  "you'll": 'you will',
  "you'd": 'you would',
  "he's": 'he is',
  "she's": 'she is',
  "it's": 'it is',
  "we're": 'we are',
  "we've": 'we have',
  "we'll": 'we will',
  "we'd": 'we would',
  "they're": 'they are',
  "they've": 'they have',
  "they'll": 'they will',
  "they'd": 'they would',
  "that's": 'that is',
  "there's": 'there is',
  "here's": 'here is',
  "what's": 'what is',
  "let's": 'let us',
};

// Precompiled, ordered longest-first so multi-token keys never partially match.
const CONTRACTION_RULES: ReadonlyArray<[RegExp, string]> = Object.entries(CONTRACTION_EXPANSIONS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([contraction, expansion]) => {
    const escaped = contraction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [new RegExp(`\\b${escaped}\\b`, 'g'), expansion] as [RegExp, string];
  });

/**
 * Expand English contractions in already-lowercased, quote-folded text.
 * Safe for equivalence checks: it canonicalizes a contraction to its long form,
 * leaving a genuinely different sentence different.
 */
export function expandContractions(text: string): string {
  let result = text;
  for (const [pattern, replacement] of CONTRACTION_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Count user-visible characters using Unicode code points (via the string
 * iterator), NOT UTF-16 code units and NOT `.length`. This is the single rule
 * shared by the frontend counter and the backend length check so the two never
 * disagree. Rationale: `.length` counts an astral character (e.g. an emoji or
 * some accented forms) as 2, which surprises users; code points count it as 1.
 * Grapheme clusters (emoji-ZWJ sequences, some combining marks) may still count
 * as more than one — full grapheme segmentation is intentionally out of scope to
 * keep the rule identical and dependency-free on both client and server.
 */
export function countCharacters(text: string): number {
  // Array.from()/spread walk the string by code points, not UTF-16 units.
  return Array.from(text).length;
}
