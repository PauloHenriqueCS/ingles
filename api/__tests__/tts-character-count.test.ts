import { describe, it, expect } from 'vitest';
import { countTtsSsmlCharacters, countTtsPlainTextCharacters } from '../_ai-gateway/tts-character-count';

describe('countTtsSsmlCharacters', () => {
  it('excludes <speak> and <voice> tags but counts everything else', () => {
    const ssml = '<speak version="1.0" xml:lang="en-US"><voice name="en-US-AvaMultilingualNeural"><prosody rate="0%">Hello</prosody></voice></speak>';
    // Remaining after stripping <speak ...>/</speak> and <voice ...>/</voice>:
    // '<prosody rate="0%">Hello</prosody>'
    const expected = '<prosody rate="0%">Hello</prosody>'.length;
    expect(countTtsSsmlCharacters(ssml)).toBe(expected);
  });

  it('counts ASCII text 1:1', () => {
    expect(countTtsSsmlCharacters('<speak><voice name="x">Hello world</voice></speak>')).toBe('Hello world'.length);
  });

  it('counts accented characters as single code points', () => {
    const inner = 'Café à la carte, ação';
    const ssml = `<speak><voice name="x">${inner}</voice></speak>`;
    expect(countTtsSsmlCharacters(ssml)).toBe(Array.from(inner).length);
    expect(countTtsSsmlCharacters(ssml)).toBe(inner.length); // accented Latin chars: 1 UTF-16 unit each too
  });

  it('counts an emoji as one character, not two UTF-16 units', () => {
    const inner = 'Hello 😀 world';
    const ssml = `<speak><voice name="x">${inner}</voice></speak>`;
    // '😀' is a surrogate pair: .length would count it as 2, code-point count as 1
    expect(inner.length).not.toBe(Array.from(inner).length);
    expect(countTtsSsmlCharacters(ssml)).toBe(Array.from(inner).length);
  });

  it('counts spaces, tabs, and line breaks as billable characters', () => {
    const inner = 'Line one\n\tLine two  with  spaces';
    const ssml = `<speak><voice name="x">${inner}</voice></speak>`;
    expect(countTtsSsmlCharacters(ssml)).toBe(Array.from(inner).length);
  });

  it('counts markup other than <speak>/<voice> (e.g. <prosody>, <break>) as billable', () => {
    const withBreak = '<speak><voice name="x">Hello<break time="500ms"/>world</voice></speak>';
    const withoutBreak = '<speak><voice name="x">Helloworld</voice></speak>';
    expect(countTtsSsmlCharacters(withBreak)).toBeGreaterThan(countTtsSsmlCharacters(withoutBreak));
  });

  it('strips multiple <speak>/<voice> tag occurrences regardless of attributes', () => {
    const ssml = '<speak version="1.0" xml:lang="en-US"><voice name="a"><voice name="b">nested</voice></voice></speak>';
    expect(countTtsSsmlCharacters(ssml)).toBe('nested'.length);
  });

  it('is deterministic — same input always yields same output', () => {
    const ssml = '<speak><voice name="x">Determinism check — 42 chars? not quite.</voice></speak>';
    const a = countTtsSsmlCharacters(ssml);
    const b = countTtsSsmlCharacters(ssml);
    expect(a).toBe(b);
  });
});

describe('countTtsPlainTextCharacters', () => {
  it('counts ASCII 1:1', () => {
    expect(countTtsPlainTextCharacters('Hello world')).toBe(11);
  });

  it('counts emoji as one code point', () => {
    const s = 'Great job! 🎉';
    expect(countTtsPlainTextCharacters(s)).toBe(Array.from(s).length);
    expect(countTtsPlainTextCharacters(s)).not.toBe(s.length);
  });

  it('counts accented characters', () => {
    expect(countTtsPlainTextCharacters('São Paulo é ótimo')).toBe(Array.from('São Paulo é ótimo').length);
  });
});
