import { describe, it, expect } from 'vitest';
import { condenseBlockDeterministically } from './condense-listening-story-block';
import { countWords } from './listening-level-config';

function sentence(n: number, words = 10): string {
  return `Sentence number ${n} has exactly ${Array.from({ length: words - 5 }, (_, i) => `word${i}`).join(' ')}.`;
}

function makeStory(sentenceCount: number, wordsPerSentence = 10): string {
  return Array.from({ length: sentenceCount }, (_, i) => sentence(i + 1, wordsPerSentence)).join(' ');
}

describe('condenseBlockDeterministically', () => {
  it('trims a too-long block down to the maximum by dropping trailing sentences', () => {
    const text = makeStory(20, 10); // ~200 words
    const result = condenseBlockDeterministically(text, 1, 50, 100);
    expect(result).not.toBeNull();
    const wc = countWords(result!);
    expect(wc).toBeGreaterThanOrEqual(50);
    expect(wc).toBeLessThanOrEqual(100);
  });

  it('never cuts mid-sentence — result is an exact whole-sentence prefix of the original', () => {
    const text = makeStory(20, 10);
    const result = condenseBlockDeterministically(text, 1, 50, 100)!;
    expect(result.length).toBeLessThan(text.length);
    expect(text.startsWith(result)).toBe(true);
  });

  it('preserves sentence order (does not reorder or drop from the middle)', () => {
    const text = makeStory(10, 10);
    const result = condenseBlockDeterministically(text, 1, 20, 60)!;
    const originalSentences = text.split(/(?<=\.)\s+/);
    const resultSentences = result.split(/(?<=\.)\s+/);
    expect(resultSentences).toEqual(originalSentences.slice(0, resultSentences.length));
  });

  it('returns null when even the first sentence alone exceeds the maximum', () => {
    const text = sentence(1, 200); // one giant sentence, no punctuation to split on
    const result = condenseBlockDeterministically(text, 1, 10, 50);
    expect(result).toBeNull();
  });

  it('returns null when no prefix reaches the minimum before exceeding the maximum', () => {
    // Each sentence is ~10 words; min=500 is unreachable within max=520 given 10-word steps
    // will overshoot before ever landing in a valid window for most cases —
    // use a pathological gap that no whole-sentence prefix can hit.
    const text = makeStory(3, 10); // ~30 words total, far short of any high minimum
    const result = condenseBlockDeterministically(text, 1, 500, 520);
    expect(result).toBeNull();
  });

  it('keeps the maximal valid prefix, not just the first one that reaches the minimum', () => {
    const text = makeStory(20, 10); // ~200 words, 10 words/sentence
    const result = condenseBlockDeterministically(text, 1, 50, 95)!;
    const wc = countWords(result);
    // Should greedily extend as far as possible without exceeding max (95),
    // not stop at the first sentence that merely satisfies the minimum (50).
    expect(wc).toBeGreaterThan(50);
    expect(wc).toBeLessThanOrEqual(95);
  });
});
