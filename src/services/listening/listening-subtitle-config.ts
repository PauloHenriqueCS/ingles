import type { CEFRLevel } from '../../domain/curriculum/cefr';

export interface CueWordCountRange {
  min: number;
  max: number;
}

/** Maximum preferred characters per visual line of subtitle text. */
export const MAX_CHARS_PER_LINE = 42;

/** Maximum visual lines per subtitle cue. */
export const MAX_LINES_PER_CUE = 2;

/** Maximum sentences that may be merged into a single cue. */
export const MAX_SENTENCES_PER_CUE = 2;

/** Word count limits per cue, by CEFR level. */
export const CUE_WORD_COUNT: Record<CEFRLevel, CueWordCountRange> = {
  A1: { min: 3, max: 9 },
  A2: { min: 4, max: 11 },
  B1: { min: 5, max: 13 },
  B2: { min: 6, max: 15 },
  C1: { min: 6, max: 17 },
  C2: { min: 6, max: 17 },
};

/**
 * Conjunctions and subordinators where a long sentence may be split.
 * Order matters: try longer patterns first.
 */
export const SPLIT_CONJUNCTIONS = [
  ' because ',
  ' although ',
  ' however ',
  ' therefore ',
  ' whereas ',
  ' unless ',
  ' while ',
  ' since ',
  ' though ',
  ' which ',
  ' where ',
  ' when ',
  ' that ',
  ' who ',
  ' and ',
  ' but ',
  ' or ',
  ' so ',
  ' as ',
  ' if ',
] as const;

/** Words that should never be separated from the next word. */
export const NO_BREAK_BEFORE = new Set([
  // Articles
  'a', 'an', 'the',
  // Prepositions
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'upon',
  // Auxiliaries
  "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't",
  "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't",
  'not',
]);
