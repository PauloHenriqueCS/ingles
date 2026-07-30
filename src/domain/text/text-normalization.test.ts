import { describe, it, expect } from 'vitest';
import {
  foldSmartQuotes,
  stripInvisibleCharacters,
  normalizeForComparison,
  normalizeForSearch,
  normalizeAnswerForComparison,
  expandContractions,
  countCharacters,
} from './text-normalization';

describe('foldSmartQuotes', () => {
  it('folds curly apostrophes to a straight one', () => {
    expect(foldSmartQuotes('I’m')).toBe("I'm");
    expect(foldSmartQuotes('don‘t')).toBe("don't");
  });
  it('folds curly double quotes', () => {
    expect(foldSmartQuotes('“hi”')).toBe('"hi"');
  });
});

describe('stripInvisibleCharacters', () => {
  it('removes zero-width and BOM characters but keeps normal text', () => {
    expect(stripInvisibleCharacters('cer​tain﻿')).toBe('certain');
  });
  it('keeps normal spaces (handled by whitespace collapse elsewhere)', () => {
    expect(stripInvisibleCharacters('a b')).toBe('a b');
  });
});

describe('normalizeForComparison', () => {
  it('lowercases, trims, collapses internal whitespace', () => {
    expect(normalizeForComparison('  She   WORKS  ')).toBe('she works');
  });
  it('collapses newlines and non-breaking spaces', () => {
    expect(normalizeForComparison('she\nworks here')).toBe('she works here');
  });
  it('strips trailing sentence punctuation by default', () => {
    expect(normalizeForComparison('She works.')).toBe('she works');
    expect(normalizeForComparison('Really?!')).toBe('really');
  });
  it('keeps trailing punctuation when asked', () => {
    expect(normalizeForComparison('She works.', { stripTrailingPunctuation: false })).toBe('she works.');
  });
  it('folds curly apostrophes so contractions compare equal', () => {
    expect(normalizeForComparison('He doesn’t')).toBe(normalizeForComparison("He doesn't"));
  });
  it('applies NFC so combining and precomposed accents match', () => {
    const combining = 'café'; // e + combining acute
    const precomposed = 'café';
    expect(normalizeForComparison(combining)).toBe(normalizeForComparison(precomposed));
  });
});

describe('expandContractions', () => {
  it('expands negatives', () => {
    expect(expandContractions("he doesn't like it")).toBe('he does not like it');
    expect(expandContractions("we can't go")).toBe('we cannot go');
    expect(expandContractions("i won't stay")).toBe('i will not stay');
  });
  it('does not touch unrelated words', () => {
    expect(expandContractions('cant is not a contraction')).toBe('cant is not a contraction');
  });
});

describe('normalizeAnswerForComparison (contraction equivalence)', () => {
  it('treats contraction and long form as equal', () => {
    expect(normalizeAnswerForComparison('He doesn’t like technology'))
      .toBe(normalizeAnswerForComparison('He does not like technology.'));
    expect(normalizeAnswerForComparison("don't"))
      .toBe(normalizeAnswerForComparison('do not'));
    expect(normalizeAnswerForComparison("can't"))
      .toBe(normalizeAnswerForComparison('cannot'));
  });
  it('keeps genuinely different sentences different', () => {
    expect(normalizeAnswerForComparison('He does not like technology'))
      .not.toBe(normalizeAnswerForComparison('He likes technology'));
  });
});

describe('normalizeForSearch', () => {
  it('keeps apostrophes and trailing punctuation but folds curly quotes', () => {
    expect(normalizeForSearch('I’m not certain.')).toBe("i'm not certain.");
  });
});

describe('countCharacters', () => {
  it('counts ASCII by length', () => {
    expect(countCharacters('hello')).toBe(5);
  });
  it('counts an astral emoji as one code point (not two UTF-16 units)', () => {
    expect('\u{1F44D}'.length).toBe(2);
    expect(countCharacters('\u{1F44D}')).toBe(1);
  });
  it('counts accented characters as one', () => {
    expect(countCharacters('café')).toBe(4);
  });
});
