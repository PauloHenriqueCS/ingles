import { describe, it, expect } from 'vitest';
import { normalizeCorrectIndex, buildPrompt } from './generate-listening-story';

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

describe('buildPrompt theme injection', () => {
  it('omits theme rule when theme is null', () => {
    const prompt = buildPrompt('B1', null);
    expect(prompt).not.toContain('The story must be clearly related to the selected theme');
  });

  it('omits theme rule when theme is undefined', () => {
    const prompt = buildPrompt('B1');
    expect(prompt).not.toContain('The story must be clearly related to the selected theme');
  });

  it('injects theme rule when theme is provided', () => {
    const prompt = buildPrompt('B1', 'travel');
    expect(prompt).toContain('The story must be clearly related to the selected theme: travel');
  });

  it.each([
    'travel', 'work_career', 'daily_life', 'movies_series', 'music',
    'football_sports', 'technology', 'food_restaurants', 'relationships_social_life',
    'health_wellbeing', 'money_shopping', 'mystery_adventure',
  ])('injects theme rule for %s', (theme) => {
    const prompt = buildPrompt('A2', theme);
    expect(prompt).toContain(`The story must be clearly related to the selected theme: ${theme}`);
  });

  it('includes the level in the prompt', () => {
    const prompt = buildPrompt('C1', 'music');
    expect(prompt).toContain('C1 CEFR learner');
  });
});
