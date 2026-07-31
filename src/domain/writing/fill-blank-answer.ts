/**
 * Answer checking for "Complete a frase" (fill-in-the-blank) exercises.
 *
 * The prompt shows a sentence with a blank and a verb hint, e.g.
 *   "She ____ (to work) in a tech company."
 * with the stored correct answer being just the conjugated form ("works").
 *
 * The input invites the learner to type the whole sentence, so we accept BOTH:
 *   - the expected token alone ("works"), and
 *   - the full resolved sentence ("She works in a tech company"),
 * comparing after shared normalization (case, punctuation, spaces, curly
 * apostrophes, contraction equivalence).
 *
 * The full sentence is accepted ONLY when it matches the sentence resolved from
 * the prompt — a sentence that merely contains the expected word is NOT accepted.
 */
import { normalizeAnswerForComparison } from '../text/text-normalization';

/** Blank markers seen in generated prompts: 2+ underscores, ellipsis, 3+ dots. */
const BLANK_PATTERN = /_{2,}|…|\.{3,}/;

/**
 * Build the sentence the prompt resolves to, by filling the blank with the
 * correct answer and removing parenthetical hints such as "(to work)".
 * Returns null when the prompt has no recognizable blank (then only the bare
 * answer can be accepted, never an arbitrary full sentence).
 */
export function buildResolvedSentence(question: string, correctAnswer: string): string | null {
  if (!question || !BLANK_PATTERN.test(question)) return null;
  const filled = question.replace(BLANK_PATTERN, ` ${correctAnswer} `);
  // Remove parenthetical verb/usage hints, e.g. "(to work)".
  return filled.replace(/\([^)]*\)/g, ' ');
}

/**
 * True if the learner's answer is correct: either the expected token, or the
 * full sentence resolved from the prompt. All comparisons go through the shared
 * normalizer, so capitalization, trailing punctuation, extra spaces, curly
 * apostrophes and equivalent contractions do not cause false negatives.
 */
export function isFillBlankAnswerCorrect(
  question: string,
  correctAnswer: string,
  userAnswer: string,
): boolean {
  const user = normalizeAnswerForComparison(userAnswer);
  if (!user) return false;

  // 1) Exactly the expected form (the stored answer).
  if (user === normalizeAnswerForComparison(correctAnswer)) return true;

  // 2) The full sentence, but only when it safely matches the resolved prompt.
  const resolved = buildResolvedSentence(question, correctAnswer);
  if (resolved && user === normalizeAnswerForComparison(resolved)) return true;

  return false;
}
