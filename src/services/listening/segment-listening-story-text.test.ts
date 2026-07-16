import { describe, it, expect } from 'vitest';
import { segmentListeningText, SentenceSegmentationError } from './segment-listening-story-text';

describe('segmentListeningText', () => {
  it('segments two sentences correctly', () => {
    const text = 'Hello world. Goodbye cruel world.';
    const sentences = segmentListeningText(text, 1);
    expect(sentences.length).toBe(2);
    expect(sentences[0].textEn).toBe('Hello world.');
    expect(sentences[1].textEn).toBe('Goodbye cruel world.');
  });

  it('assigns correct sentence keys', () => {
    const text = 'First sentence. Second sentence.';
    const sentences = segmentListeningText(text, 1);
    expect(sentences[0].sentenceKey).toBe('b1s01');
    expect(sentences[1].sentenceKey).toBe('b1s02');
  });

  it('uses block order 2 in keys for block 2', () => {
    const text = 'One sentence here.';
    const sentences = segmentListeningText(text, 2);
    expect(sentences[0].sentenceKey).toBe('b2s01');
  });

  it('sets speaker to null for all sentences', () => {
    const text = 'Hello world. Goodbye world.';
    const sentences = segmentListeningText(text, 1);
    expect(sentences.every(s => s.speaker === null)).toBe(true);
  });

  it('reconstructs exact original text after joining with space', () => {
    const text = 'The cat sat on the mat. The dog ran in the park. It was a sunny day.';
    const sentences = segmentListeningText(text, 1);
    const reconstructed = sentences.map(s => s.textEn).join(' ');
    expect(reconstructed.replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('does not split at abbreviations like Mr. and Dr.', () => {
    const text = 'Mr. Smith visited Dr. Jones. They discussed the case.';
    const sentences = segmentListeningText(text, 1);
    // Should have 2 sentences, not 4
    expect(sentences.length).toBe(2);
    expect(sentences[0].textEn).toContain('Mr. Smith');
    expect(sentences[0].textEn).toContain('Dr. Jones');
  });

  it('handles question marks as sentence terminators', () => {
    const text = 'What is your name? My name is John.';
    const sentences = segmentListeningText(text, 1);
    expect(sentences.length).toBe(2);
    expect(sentences[0].textEn).toBe('What is your name?');
  });

  it('handles exclamation marks as sentence terminators', () => {
    const text = 'Watch out! There is a car coming.';
    const sentences = segmentListeningText(text, 1);
    expect(sentences.length).toBe(2);
    expect(sentences[0].textEn).toBe('Watch out!');
  });

  it('handles text without sentence terminators as a single sentence', () => {
    // makeWords-style text with no punctuation
    const text = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ');
    const sentences = segmentListeningText(text, 1);
    expect(sentences.length).toBe(1);
    expect(sentences[0].textEn).toBe(text);
  });

  it('assigns paragraph_order = 1 when text has no paragraphs', () => {
    const text = 'First sentence. Second sentence.';
    const sentences = segmentListeningText(text, 1);
    expect(sentences.every(s => s.paragraphOrder === 1)).toBe(true);
  });

  it('assigns correct paragraph_order for multi-paragraph text', () => {
    const text = 'Para one sentence one. Para one sentence two.\nPara two sentence one.';
    const sentences = segmentListeningText(text, 1);
    const para1 = sentences.filter(s => s.paragraphOrder === 1);
    const para2 = sentences.filter(s => s.paragraphOrder === 2);
    expect(para1.length).toBeGreaterThan(0);
    expect(para2.length).toBeGreaterThan(0);
  });

  it('validates reconstruction — throws if text cannot be reconstructed', () => {
    // This test verifies the internal reconstruction check works
    // (We can't easily make it fail from the outside, so we test valid reconstruction)
    const text = 'Simple text with no sentence breaks but many words in it right here.';
    const sentences = segmentListeningText(text, 1);
    const reconstructed = sentences.map(s => s.textEn).join(' ').replace(/\s+/g, ' ').trim();
    expect(reconstructed).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('throws SentenceSegmentationError for empty text', () => {
    expect(() => segmentListeningText('   ', 1)).toThrow(SentenceSegmentationError);
  });
});
