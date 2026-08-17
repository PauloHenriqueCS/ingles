import { describe, it, expect } from 'vitest';
import { normalizeAnswer, isAnswerCorrect } from './answer-check';

describe('normalizeAnswer', () => {
  it('lowercases, collapses whitespace and strips edge punctuation', () => {
    expect(normalizeAnswer('  I depend  ON him. ')).toBe('i depend on him');
  });

  it('preserves internal punctuation', () => {
    expect(normalizeAnswer("It's from 8 a.m. to 6 p.m.")).toBe("it's from 8 a.m. to 6 p.m");
  });

  it('handles null/undefined', () => {
    expect(normalizeAnswer(null)).toBe('');
    expect(normalizeAnswer(undefined)).toBe('');
  });
});

describe('isAnswerCorrect', () => {
  const corrected = 'I depend on him';
  const original = 'I depend of him';

  it('accepts the corrected form regardless of case/spacing/trailing punctuation', () => {
    expect(isAnswerCorrect('i depend on him.', corrected, original)).toBe(true);
    expect(isAnswerCorrect('  I  depend   ON him ', corrected, original)).toBe(true);
  });

  it('rejects a response that keeps the reviewed error', () => {
    expect(isAnswerCorrect('I depend of him', corrected, original)).toBe(false);
  });

  it('rejects an unrelated answer', () => {
    expect(isAnswerCorrect('I trust him', corrected, original)).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(isAnswerCorrect('', corrected, original)).toBe(false);
  });

  it('when corrected == original after normalization (cosmetic-only), matching corrected passes', () => {
    // e.g. the only difference was capitalization/punctuation the normalizer ignores
    expect(isAnswerCorrect('hello world', 'Hello world.', 'hello world')).toBe(true);
  });

  it('accepts a multi-word corrected expression kept intact', () => {
    const cor = 'I work from 8 a.m. to 6 p.m.';
    const org = 'I work since 8 a.m. until 6 p.m.';
    expect(isAnswerCorrect('I work from 8 a.m. to 6 p.m.', cor, org)).toBe(true);
    expect(isAnswerCorrect('I work since 8 a.m. until 6 p.m.', cor, org)).toBe(false);
  });
});
