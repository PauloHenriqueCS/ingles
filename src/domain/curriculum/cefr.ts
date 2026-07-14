export type CEFRLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

const LEVEL_ORDER: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export function cefrIndex(level: CEFRLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export function cefrAtLeast(level: CEFRLevel, minimum: CEFRLevel): boolean {
  return cefrIndex(level) >= cefrIndex(minimum);
}

export function cefrCompare(a: CEFRLevel, b: CEFRLevel): number {
  return cefrIndex(a) - cefrIndex(b);
}

export function cefrMin(a: CEFRLevel, b: CEFRLevel): CEFRLevel {
  return cefrIndex(a) <= cefrIndex(b) ? a : b;
}

export function cefrMax(a: CEFRLevel, b: CEFRLevel): CEFRLevel {
  return cefrIndex(a) >= cefrIndex(b) ? a : b;
}

export const ALL_CEFR_LEVELS: readonly CEFRLevel[] = LEVEL_ORDER;
