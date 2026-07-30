import { describe, it, expect } from 'vitest';
import { extractGrammarFocusLabels, findMistakeForTopic } from './grammar-focus-topics';
import { resolveLegacyGrammarTopic } from '../curriculum/legacy-grammar-aliases';

const pastMistake = { original: 'I go yesterday', correct: 'I went yesterday', explanation: 'Use o simple past.' };
const prepMistake = { original: 'in the morning at monday', correct: 'on Monday', explanation: 'Preposition of time.' };
const pluralMistake = { original: 'two cat', correct: 'two cats', explanation: 'plural precisa de -s' };

describe('extractGrammarFocusLabels', () => {
  it('extracts the topics present in the mistakes, de-duplicated', () => {
    const labels = extractGrammarFocusLabels([pastMistake, prepMistake, pastMistake]);
    expect(labels).toContain('Simple Past');
    expect(labels).toContain('Prepositions');
    expect(labels.filter((l) => l === 'Simple Past')).toHaveLength(1);
  });
  it('returns nothing for mistakes that match no topic rule', () => {
    expect(extractGrammarFocusLabels([{ original: 'zzz', correct: 'qqq', explanation: 'nada' }])).toEqual([]);
  });
});

describe('findMistakeForTopic', () => {
  it('finds the concrete mistake that produced a topic label', () => {
    const m = findMistakeForTopic('Plural', [pastMistake, pluralMistake]);
    expect(m).toBe(pluralMistake);
  });
  it('returns null when no mistake matches the topic', () => {
    expect(findMistakeForTopic('Comparatives', [pastMistake])).toBeNull();
  });
  it('returns null for an unknown topic label', () => {
    expect(findMistakeForTopic('Nonexistent', [pastMistake])).toBeNull();
  });
});

describe('every chip label resolves to catalog content or an explicit null (no AI needed)', () => {
  // The nine labels extractGrammarFocus can emit.
  const RESOLVE_TO_TOPIC = ['Simple Past', 'Prepositions', 'Articles', 'Plural', 'Present Continuous', 'Future', 'Comparatives'];
  const RESOLVE_TO_NULL = ['Word Order', 'Sentence Structure'];

  for (const label of RESOLVE_TO_TOPIC) {
    it(`"${label}" resolves to a catalog topic`, () => {
      const topic = resolveLegacyGrammarTopic(label);
      expect(topic, `${label} should resolve`).not.toBeNull();
      expect(topic!.title.ptBR.length).toBeGreaterThan(0);
    });
  }
  for (const label of RESOLVE_TO_NULL) {
    it(`"${label}" is explicitly null (UI falls back to the learner's error context)`, () => {
      expect(resolveLegacyGrammarTopic(label)).toBeNull();
    });
  }
});
