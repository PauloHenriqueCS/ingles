import { useMemo } from 'react';
import { RequiredWordValidation, ValidationResult } from '../types';

function isWordFound(requiredWord: string, text: string): boolean {
  if (!requiredWord.includes(' ')) {
    for (const token of text.split(/\s+/)) {
      const clean = token.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
      if (clean.toLowerCase() === requiredWord.toLowerCase()) return true;
    }
    return false;
  }

  const lowerText = text.toLowerCase();
  const lowerPhrase = requiredWord.toLowerCase();
  const isAlnum = (c: string | null): boolean => c !== null && /[a-z0-9]/.test(c);
  const phraseStartsWithAlnum = /[a-z0-9]/.test(lowerPhrase[0]);
  const phraseEndsWithAlnum = /[a-z0-9]/.test(lowerPhrase[lowerPhrase.length - 1]);

  let idx = lowerText.indexOf(lowerPhrase);
  while (idx !== -1) {
    const before = idx > 0 ? lowerText[idx - 1] : null;
    const after = idx + lowerPhrase.length < lowerText.length ? lowerText[idx + lowerPhrase.length] : null;
    const beforeOk = !phraseStartsWithAlnum || !isAlnum(before);
    const afterOk = !phraseEndsWithAlnum || !isAlnum(after);
    if (beforeOk && afterOk) return true;
    idx = lowerText.indexOf(lowerPhrase, idx + 1);
  }
  return false;
}

export function useRequiredWordsValidation(
  requiredWords: string[] | undefined,
  text: string,
): ValidationResult {
  return useMemo(() => {
    if (!requiredWords || requiredWords.length === 0) {
      return { words: [], allFound: true, missingWords: [] };
    }
    const words: RequiredWordValidation[] = requiredWords.map((word) => ({
      word,
      status: isWordFound(word, text) ? 'found' : 'missing',
    }));
    const missingWords = words.filter((w) => w.status === 'missing').map((w) => w.word);
    return { words, allFound: missingWords.length === 0, missingWords };
  }, [requiredWords, text]);
}
