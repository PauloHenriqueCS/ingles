import { describe, it, expect } from 'vitest';
import { validateRewriteText } from './rewrite-text-validation';

describe('validateRewriteText', () => {
  it('accepts a normal, imperfect English rewrite', () => {
    const r = validateRewriteText('Yesterday I went to the market and bought some fruits.');
    expect(r.valid).toBe(true);
  });

  it('accepts a short but legitimate A1-level sentence (never requires a long text)', () => {
    const r = validateRewriteText('I like cats.');
    expect(r.valid).toBe(true);
  });

  it('accepts text with minor typos (not a spell-checker)', () => {
    const r = validateRewriteText('I lik cats and dogs very much.');
    expect(r.valid).toBe(true);
  });

  it('accepts numbers mixed into otherwise valid text', () => {
    const r = validateRewriteText('I have 2 dogs and 1 cat at home.');
    expect(r.valid).toBe(true);
  });

  it('rejects an empty string', () => {
    const r = validateRewriteText('');
    expect(r.valid).toBe(false);
    expect(r.reasonCode).toBe('EMPTY');
  });

  it('rejects a whitespace-only string', () => {
    const r = validateRewriteText('   \n\t  ');
    expect(r.valid).toBe(false);
    expect(r.reasonCode).toBe('EMPTY');
  });

  it('rejects the exact reported bug input: a single run-on gibberish token', () => {
    const r = validateRewriteText('5eysvduduud');
    expect(r.valid).toBe(false);
    expect(r.reasonCode).toBe('TOO_FEW_WORDS');
  });

  it('rejects keyboard-mash gibberish even when split into multiple tokens', () => {
    const r = validateRewriteText('xkcd qzwe mnbv zxqw');
    expect(r.valid).toBe(false);
    expect(r.reasonCode).toBe('NOT_ENGLISH_LIKE');
  });

  it('rejects mostly-digit/symbol content', () => {
    const r = validateRewriteText('123 456 789 !!! ###');
    expect(r.valid).toBe(false);
  });

  it('rejects a single real word repeated (still too few words)', () => {
    const r = validateRewriteText('cat');
    expect(r.valid).toBe(false);
    expect(r.reasonCode).toBe('TOO_FEW_WORDS');
  });

  it('every invalid result carries a non-empty, user-facing message', () => {
    for (const input of ['', '5eysvduduud', 'xkcd qzwe mnbv zxqw']) {
      const r = validateRewriteText(input);
      expect(r.valid).toBe(false);
      expect(r.message).toBeTruthy();
    }
  });
});
