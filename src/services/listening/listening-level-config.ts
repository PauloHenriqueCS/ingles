import type { CEFRLevel } from '../../domain/curriculum/cefr';

export interface WordCountRange {
  min: number;
  max: number;
}

export const WORD_COUNT_RANGES: Record<CEFRLevel, WordCountRange> = {
  A1: { min: 400, max: 475 },
  A2: { min: 450, max: 525 },
  B1: { min: 500, max: 575 },
  B2: { min: 550, max: 625 },
  C1: { min: 575, max: 675 },
  C2: { min: 575, max: 675 },
};

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
