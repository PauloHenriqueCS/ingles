import { describe, it, expect } from 'vitest';
import {
  sanitizeDistractors,
  ERROR_REVIEW_DISTRACTOR_COUNT,
  ERROR_REVIEW_CHOICE_COUNT,
} from './distractors';
import { normalizeAnswer } from './answer-check';

describe('sanitizeDistractors', () => {
  it('accepts exactly 3 valid, distinct distractors and preserves their spelling', () => {
    const out = sanitizeDistractors('we were', ['we is', 'we be', 'we are was']);
    expect(out).toEqual(['we is', 'we be', 'we are was']);
  });

  it('the constants describe a 4-option multiple choice', () => {
    expect(ERROR_REVIEW_DISTRACTOR_COUNT).toBe(3);
    expect(ERROR_REVIEW_CHOICE_COUNT).toBe(4);
  });

  it('rejects a distractor equal (normalized) to the correct answer', () => {
    // "We Were" normalizes to the correct answer -> not a valid distractor.
    expect(sanitizeDistractors('we were', ['We Were!', 'we is', 'we be'])).toBeNull();
  });

  it('never lets a distractor equal the correct answer, so none can be scored as a pass', () => {
    const out = sanitizeDistractors('we were', ['we is', 'we be', 'we are was']);
    const correctNorm = normalizeAnswer('we were');
    for (const d of out!) expect(normalizeAnswer(d)).not.toBe(correctNorm);
  });

  it('drops duplicates (normalized) and needs 3 UNIQUE survivors', () => {
    // "we is" and "We is." collapse to one -> only 2 unique -> null.
    expect(sanitizeDistractors('we were', ['we is', 'We is.', 'we be'])).toBeNull();
  });

  it('keeps the first 3 unique when the model over-produces', () => {
    const out = sanitizeDistractors('went', ['goed', 'gone', 'goes', 'go', 'wented']);
    expect(out).toEqual(['goed', 'gone', 'goes']);
  });

  it('allows a distractor equal to the original error (a plausible option)', () => {
    // "we was" (the student's own error) is a valid, desirable distractor.
    const out = sanitizeDistractors('we were', ['we was', 'we is', 'we be']);
    expect(out).toContain('we was');
  });

  it('ignores non-strings, empty and whitespace-only entries', () => {
    expect(sanitizeDistractors('went', ['goed', '', '   ', 42 as unknown as string, 'gone', 'goes']))
      .toEqual(['goed', 'gone', 'goes']);
  });

  it('returns null when fewer than 3 valid distractors remain', () => {
    expect(sanitizeDistractors('went', ['goed'])).toBeNull();
    expect(sanitizeDistractors('went', [])).toBeNull();
  });

  it('returns null for a non-array input', () => {
    expect(sanitizeDistractors('went', undefined)).toBeNull();
    expect(sanitizeDistractors('went', null)).toBeNull();
    expect(sanitizeDistractors('went', 'goed, gone, goes')).toBeNull();
  });

  it('trims surrounding whitespace on the surviving distractors', () => {
    const out = sanitizeDistractors('went', ['  goed ', 'gone', ' goes']);
    expect(out).toEqual(['goed', 'gone', 'goes']);
  });
});
