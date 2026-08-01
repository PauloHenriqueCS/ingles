import { describe, it, expect } from 'vitest';
import { isFillBlankAnswerCorrect, buildResolvedSentence } from './fill-blank-answer';

const QUESTION = 'She ____ (to work) in a tech company.';
const ANSWER = 'works';

describe('buildResolvedSentence', () => {
  it('fills the blank and removes the verb hint', () => {
    expect(normalize(buildResolvedSentence(QUESTION, ANSWER))).toBe('she works in a tech company.');
  });
  it('returns null when there is no blank marker', () => {
    expect(buildResolvedSentence('No blank here', ANSWER)).toBeNull();
  });
});

function normalize(s: string | null): string | null {
  return s ? s.replace(/\s+/g, ' ').trim().toLowerCase() : s;
}

describe('isFillBlankAnswerCorrect', () => {
  it('accepts only the correct word', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'works')).toBe(true);
  });
  it('accepts the full correct sentence', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'She works in a tech company')).toBe(true);
  });
  it('accepts the full sentence with a trailing period', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'She works in a tech company.')).toBe(true);
  });
  it('accepts different capitalization', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'WORKS')).toBe(true);
  });
  it('accepts extra internal/edge whitespace', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, '  she   works  in a tech company ')).toBe(true);
  });
  it('rejects the correct word placed inside an incorrect sentence', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'She works at a big hospital')).toBe(false);
  });
  it('rejects the wrong verb form', () => {
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'work')).toBe(false);
    expect(isFillBlankAnswerCorrect(QUESTION, ANSWER, 'working')).toBe(false);
  });

  describe('contraction equivalence', () => {
    const Q = 'He ____ (not / to like) technology.';
    const A = "doesn't like";
    it('accepts the contraction form', () => {
      expect(isFillBlankAnswerCorrect(Q, A, "He doesn’t like technology")).toBe(true);
    });
    it('accepts the expanded form', () => {
      expect(isFillBlankAnswerCorrect(Q, A, 'He does not like technology.')).toBe(true);
    });
    it('accepts the bare answer with a curly apostrophe', () => {
      expect(isFillBlankAnswerCorrect(Q, A, "doesn’t like")).toBe(true);
    });
  });
});
