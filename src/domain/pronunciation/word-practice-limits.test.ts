import { describe, it, expect } from 'vitest';
import {
  WORD_PRACTICE_MAX_ATTEMPTS,
  WORD_PRACTICE_MAX_DURATION_MS,
  WORD_PRACTICE_MAX_DURATION_SECONDS,
  isWordPracticeOwnerType,
  normalizeWordForPractice,
  wordPracticeAttemptLabel,
  wordPracticeAttemptsExhausted,
} from './word-practice-limits';

describe('word-practice limit constants', () => {
  it('are the fixed product rule: 3 attempts, 5 seconds', () => {
    expect(WORD_PRACTICE_MAX_ATTEMPTS).toBe(3);
    expect(WORD_PRACTICE_MAX_DURATION_SECONDS).toBe(5);
    expect(WORD_PRACTICE_MAX_DURATION_MS).toBe(5000);
  });
});

describe('wordPracticeAttemptLabel', () => {
  it('names the upcoming attempt while tries remain', () => {
    expect(wordPracticeAttemptLabel(0)).toBe('Tentativa 1 de 3');
    expect(wordPracticeAttemptLabel(1)).toBe('Tentativa 2 de 3');
    expect(wordPracticeAttemptLabel(2)).toBe('Tentativa 3 de 3');
  });

  it('shows the exhausted state once all attempts are used (and never overflows)', () => {
    expect(wordPracticeAttemptLabel(3)).toBe('3 de 3 tentativas usadas');
    expect(wordPracticeAttemptLabel(4)).toBe('3 de 3 tentativas usadas');
  });
});

describe('wordPracticeAttemptsExhausted', () => {
  it('is true only at/after the max', () => {
    expect(wordPracticeAttemptsExhausted(0)).toBe(false);
    expect(wordPracticeAttemptsExhausted(2)).toBe(false);
    expect(wordPracticeAttemptsExhausted(3)).toBe(true);
    expect(wordPracticeAttemptsExhausted(5)).toBe(true);
  });
});

describe('normalizeWordForPractice (must match the SQL rule)', () => {
  it('lowercases and strips leading/trailing punctuation', () => {
    expect(normalizeWordForPractice('Chocolate')).toBe('chocolate');
    expect(normalizeWordForPractice('Chocolate,')).toBe('chocolate');
    expect(normalizeWordForPractice('  CHOCOLATE.  ')).toBe('chocolate');
    expect(normalizeWordForPractice('"vanilla"')).toBe('vanilla');
  });

  it('keeps inner apostrophes/hyphens but collapses surrounding noise', () => {
    expect(normalizeWordForPractice("don't")).toBe("don't");
    expect(normalizeWordForPractice('well-known!')).toBe('well-known');
  });

  it('all variants of the same word map to one counter key', () => {
    const variants = ['chocolate', 'Chocolate,', ' CHOCOLATE ', '(chocolate)'];
    const keys = new Set(variants.map(normalizeWordForPractice));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('chocolate');
  });
});

describe('isWordPracticeOwnerType', () => {
  it('accepts only the two anchored contexts', () => {
    expect(isWordPracticeOwnerType('training')).toBe(true);
    expect(isWordPracticeOwnerType('writing')).toBe(true);
    expect(isWordPracticeOwnerType('other')).toBe(false);
    expect(isWordPracticeOwnerType(null)).toBe(false);
    expect(isWordPracticeOwnerType(undefined)).toBe(false);
  });
});
