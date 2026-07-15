import { PronunciationWordDetail, WordBand, getWordBand } from './pronunciationWordParser';

export type TrainingCategory = 'boa' | 'pode-melhorar' | 'pratique';

export const TRAINING_CATEGORY_LABELS: Record<TrainingCategory, string> = {
  'boa': 'Boa',
  'pode-melhorar': 'Pode melhorar',
  'pratique': 'Pratique',
};

export const TRAINING_CATEGORY_COLORS: Record<TrainingCategory, {
  text: string;
  bg: string;
  border: string;
}> = {
  'boa':          { text: 'text-green-400',  bg: 'bg-green-900/30',  border: 'border-green-700'  },
  'pode-melhorar':{ text: 'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-700' },
  'pratique':     { text: 'text-red-400',    bg: 'bg-red-900/30',    border: 'border-red-700'    },
};

// Thresholds — centralised so they can be adjusted without hunting across files
export const TRAINING_SCORE_THRESHOLDS = {
  GOOD: 80,    // >= 80 → "Boa"
  IMPROVE: 60, // 60–79.x → "Pode melhorar"; < 60 → "Pratique"
} as const;

/**
 * Maps any Azure word detail to one of the three training categories.
 *
 * Per spec:
 *   - omission, mispronunciation, insertion → always "Pratique" regardless of score
 *   - null score → "Pratique" (conservative fallback)
 *   - score >= 80 → "Boa"
 *   - score 60–79.x → "Pode melhorar"
 *   - score < 60 → "Pratique"
 */
export function getWordTrainingCategory(word: PronunciationWordDetail): TrainingCategory {
  if (
    word.errorType === 'omission' ||
    word.errorType === 'mispronunciation' ||
    word.errorType === 'insertion'
  ) {
    return 'pratique';
  }
  if (word.accuracyScore === null) return 'pratique';
  if (word.accuracyScore >= TRAINING_SCORE_THRESHOLDS.GOOD) return 'boa';
  if (word.accuracyScore >= TRAINING_SCORE_THRESHOLDS.IMPROVE) return 'pode-melhorar';
  return 'pratique';
}

export function needsPractice(word: PronunciationWordDetail): boolean {
  const cat = getWordTrainingCategory(word);
  return cat === 'pode-melhorar' || cat === 'pratique';
}

// Simple band → category mapping (no full word detail needed)
export function categoryFromBand(band: WordBand): TrainingCategory {
  switch (band) {
    case 'good': return 'boa';
    case 'attention': return 'pode-melhorar';
    default: return 'pratique';
  }
}

// Re-export so callers that need band info can still get it without importing two files
export { getWordBand };
