import { useMemo } from 'react';
import { RequiredWordValidation, ValidationResult } from '../types';
import { isRequiredWordPresent } from '../domain/writing/required-words-match';

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
      status: isRequiredWordPresent(word, text) ? 'found' : 'missing',
    }));
    const missingWords = words.filter((w) => w.status === 'missing').map((w) => w.word);
    return { words, allFound: missingWords.length === 0, missingWords };
  }, [requiredWords, text]);
}
