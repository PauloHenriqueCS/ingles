import { describe, it, expect } from 'vitest';
import { visibleVocabulary } from './mission-vocabulary';
import type { VocabularyItem } from '../../types';

const item = (word: string): VocabularyItem => ({ word, meaningPtBr: 'x', example: 'y' });

describe('visibleVocabulary — empty-vocabulary bug guard', () => {
  it('returns [] for null/undefined/non-array', () => {
    expect(visibleVocabulary(null)).toEqual([]);
    expect(visibleVocabulary(undefined)).toEqual([]);
    // @ts-expect-error — defensive against malformed AI payloads
    expect(visibleVocabulary('nope')).toEqual([]);
  });

  it('drops items with a blank or missing word', () => {
    const items = [
      item('hello'),
      item('   '),
      { word: '', meaningPtBr: 'a', example: 'b' } as VocabularyItem,
      { meaningPtBr: 'a', example: 'b' } as unknown as VocabularyItem,
      item('world'),
    ];
    expect(visibleVocabulary(items).map((v) => v.word)).toEqual(['hello', 'world']);
  });

  it('returns [] (so the section hides) when every item is blank', () => {
    const items = [
      { word: '', meaningPtBr: 'a', example: 'b' } as VocabularyItem,
      item('  '),
    ];
    expect(visibleVocabulary(items)).toEqual([]);
  });

  it('keeps a fully-populated list unchanged', () => {
    const items = [item('a'), item('b')];
    expect(visibleVocabulary(items)).toHaveLength(2);
  });
});
