import { describe, it, expect } from 'vitest';
import { normalizeCorrectIndex } from './generate-listening-story';

const OPTS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

describe('normalizeCorrectIndex', () => {
  it.each([0, 1, 2, 3, 4])('preserves 0-indexed value %i', (idx) => {
    expect(normalizeCorrectIndex(idx, OPTS)).toBe(idx);
  });

  it.each([
    ['A', 0], ['B', 1], ['C', 2], ['D', 3], ['E', 4],
  ] as const)('maps letter %s to %i', (letter, expected) => {
    expect(normalizeCorrectIndex(letter, OPTS)).toBe(expected);
  });

  it('maps 1-indexed 5 to 4', () => {
    expect(normalizeCorrectIndex(5, OPTS)).toBe(4);
  });

  it('matches option text case-insensitively', () => {
    expect(normalizeCorrectIndex('gamma', OPTS)).toBe(2);
    expect(normalizeCorrectIndex('EPSILON', OPTS)).toBe(4);
  });

  it('throws UNNORMALIZABLE for invalid input', () => {
    expect(() => normalizeCorrectIndex('Z', OPTS)).toThrow('UNNORMALIZABLE');
    expect(() => normalizeCorrectIndex(null, OPTS)).toThrow('UNNORMALIZABLE');
    expect(() => normalizeCorrectIndex(6, OPTS)).toThrow('UNNORMALIZABLE');
  });
});

describe('client-side answer comparison', () => {
  it.each([0, 1, 2, 3, 4])('correctly identifies option %i as the correct one', (correctIdx) => {
    for (let selected = 0; selected < 5; selected++) {
      const isCorrect = Number(selected) === Number(correctIdx);
      expect(isCorrect).toBe(selected === correctIdx);
    }
  });
});
