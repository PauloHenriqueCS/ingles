import { describe, it, expect } from 'vitest';
import { isRequiredWordPresent } from './required-words-match';

describe('isRequiredWordPresent — single word', () => {
  it('matches regardless of case', () => {
    expect(isRequiredWordPresent('Certain', 'I am CERTAIN about it')).toBe(true);
  });
  it('does not match a word contained inside another word', () => {
    expect(isRequiredWordPresent('cat', 'the category is broad')).toBe(false);
  });
  it('matches a token surrounded by punctuation', () => {
    expect(isRequiredWordPresent('sure', 'Are you sure?')).toBe(true);
  });
});

describe('isRequiredWordPresent — phrase (curly vs straight apostrophe)', () => {
  const phrase = "I'm not certain";

  it('matches when the text uses a curly apostrophe', () => {
    expect(isRequiredWordPresent(phrase, 'Well, I’m not certain about that.')).toBe(true);
  });
  it('matches when the required phrase uses a curly apostrophe and text is straight', () => {
    expect(isRequiredWordPresent('I’m not certain', "I'm not certain yet")).toBe(true);
  });
  it('matches across a line break between words', () => {
    expect(isRequiredWordPresent('not certain', 'I am not\ncertain')).toBe(true);
  });
  it('matches with extra spaces', () => {
    expect(isRequiredWordPresent(phrase, "I'm   not   certain")).toBe(true);
  });
  it('matches the phrase surrounded by punctuation', () => {
    expect(isRequiredWordPresent(phrase, "(I'm not certain).")).toBe(true);
  });
  it('does not match when the phrase is only partially present', () => {
    expect(isRequiredWordPresent(phrase, "I'm not")).toBe(false);
  });
  it('does not match a genuinely different phrase', () => {
    expect(isRequiredWordPresent(phrase, 'I am absolutely sure')).toBe(false);
  });
  it('ignores invisible characters inserted by mobile keyboards', () => {
    expect(isRequiredWordPresent(phrase, "I'm​ not certain")).toBe(true);
  });
});
