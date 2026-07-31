/**
 * Presence check for "Palavras obrigatórias" / "Frases obrigatórias".
 *
 * Pure and framework-free so it can be unit-tested and reused by the React hook
 * (useRequiredWordsValidation) on both web and iPhone. Both the required word
 * and the learner text are run through the shared search normalizer, so a curly
 * apostrophe (I’m) matches a straight one (I'm), case/spacing/line-breaks and
 * invisible characters do not matter, and the original text is never mutated.
 *
 * Matching stays conservative: a single required word must appear as a whole
 * token (never inside another word), and a required phrase must appear as a
 * contiguous sequence with alphanumeric word boundaries.
 */
import { normalizeForSearch } from '../text/text-normalization';

const isAlnum = (c: string | null): boolean => c !== null && /[a-z0-9]/.test(c);

export function isRequiredWordPresent(requiredWord: string, text: string): boolean {
  const word = normalizeForSearch(requiredWord);
  if (!word) return false;
  const haystack = normalizeForSearch(text);

  // Single word: compare token by token after trimming surrounding punctuation.
  if (!word.includes(' ')) {
    for (const token of haystack.split(' ')) {
      const clean = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
      if (clean === word) return true;
    }
    return false;
  }

  // Phrase: contiguous substring match with word-boundary checks so a phrase is
  // not matched in the middle of longer words.
  const startsWithAlnum = isAlnum(word[0]);
  const endsWithAlnum = isAlnum(word[word.length - 1]);
  let idx = haystack.indexOf(word);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : null;
    const after = idx + word.length < haystack.length ? haystack[idx + word.length] : null;
    const beforeOk = !startsWithAlnum || !isAlnum(before);
    const afterOk = !endsWithAlnum || !isAlnum(after);
    if (beforeOk && afterOk) return true;
    idx = haystack.indexOf(word, idx + 1);
  }
  return false;
}
