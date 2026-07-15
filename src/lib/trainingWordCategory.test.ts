import { describe, it, expect } from 'vitest';
import {
  getWordTrainingCategory,
  needsPractice,
  categoryFromBand,
  TRAINING_SCORE_THRESHOLDS,
} from './trainingWordCategory';
import type { PronunciationWordDetail } from './pronunciationWordParser';

function makeWord(
  errorType: PronunciationWordDetail['errorType'],
  accuracyScore: number | null,
): PronunciationWordDetail {
  return {
    id: 'test-word',
    referenceWord: 'word',
    recognizedWord: errorType === 'omission' ? null : 'word',
    displayWord: 'word',
    normalizedWord: 'word',
    accuracyScore,
    errorType,
    offset: null,
    duration: null,
    syllables: [],
    phonemes: [],
  };
}

// ── Score-based classification ────────────────────────────────────────────────

describe('getWordTrainingCategory — score-based (errorType "none")', () => {
  it('score >= 80 → "boa"', () => {
    expect(getWordTrainingCategory(makeWord('none', 80))).toBe('boa');
    expect(getWordTrainingCategory(makeWord('none', 100))).toBe('boa');
    expect(getWordTrainingCategory(makeWord('none', 80.5))).toBe('boa');
    expect(getWordTrainingCategory(makeWord('none', 95))).toBe('boa');
  });

  it('score 60 a 79.x → "pode-melhorar"', () => {
    expect(getWordTrainingCategory(makeWord('none', 60))).toBe('pode-melhorar');
    expect(getWordTrainingCategory(makeWord('none', 70))).toBe('pode-melhorar');
    expect(getWordTrainingCategory(makeWord('none', 79))).toBe('pode-melhorar');
    expect(getWordTrainingCategory(makeWord('none', 79.99))).toBe('pode-melhorar');
  });

  it('score < 60 → "pratique"', () => {
    expect(getWordTrainingCategory(makeWord('none', 0))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('none', 30))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('none', 59))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('none', 59.9))).toBe('pratique');
  });

  it('limiar exato GOOD (80) → "boa"', () => {
    expect(getWordTrainingCategory(makeWord('none', TRAINING_SCORE_THRESHOLDS.GOOD))).toBe('boa');
  });

  it('um ponto abaixo de GOOD (79.9) → "pode-melhorar"', () => {
    expect(getWordTrainingCategory(makeWord('none', TRAINING_SCORE_THRESHOLDS.GOOD - 0.1))).toBe('pode-melhorar');
  });

  it('limiar exato IMPROVE (60) → "pode-melhorar"', () => {
    expect(getWordTrainingCategory(makeWord('none', TRAINING_SCORE_THRESHOLDS.IMPROVE))).toBe('pode-melhorar');
  });

  it('um ponto abaixo de IMPROVE (59.9) → "pratique"', () => {
    expect(getWordTrainingCategory(makeWord('none', TRAINING_SCORE_THRESHOLDS.IMPROVE - 0.1))).toBe('pratique');
  });
});

// ── Error-type overrides ──────────────────────────────────────────────────────

describe('getWordTrainingCategory — error type override (spec: omissão/incorreta = Pratique)', () => {
  it('omissão → "pratique" independente do score', () => {
    expect(getWordTrainingCategory(makeWord('omission', null))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('omission', 100))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('omission', 0))).toBe('pratique');
  });

  it('mispronunciation → "pratique" mesmo com score alto', () => {
    expect(getWordTrainingCategory(makeWord('mispronunciation', 90))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('mispronunciation', 80))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('mispronunciation', 40))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('mispronunciation', null))).toBe('pratique');
  });

  it('insertion → "pratique"', () => {
    expect(getWordTrainingCategory(makeWord('insertion', 100))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('insertion', 80))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('insertion', 0))).toBe('pratique');
  });

  it('score null com errorType "none" → "pratique" (sem dados suficientes)', () => {
    expect(getWordTrainingCategory(makeWord('none', null))).toBe('pratique');
    expect(getWordTrainingCategory(makeWord('unknown', null))).toBe('pratique');
  });
});

// ── needsPractice ─────────────────────────────────────────────────────────────

describe('needsPractice', () => {
  it('retorna false para palavra "boa" (score >= 80)', () => {
    expect(needsPractice(makeWord('none', 90))).toBe(false);
    expect(needsPractice(makeWord('none', 80))).toBe(false);
    expect(needsPractice(makeWord('none', 100))).toBe(false);
  });

  it('retorna true para "pode-melhorar" (score 60–79)', () => {
    expect(needsPractice(makeWord('none', 70))).toBe(true);
    expect(needsPractice(makeWord('none', 60))).toBe(true);
    expect(needsPractice(makeWord('none', 79))).toBe(true);
  });

  it('retorna true para "pratique" (score < 60)', () => {
    expect(needsPractice(makeWord('none', 40))).toBe(true);
    expect(needsPractice(makeWord('none', 0))).toBe(true);
  });

  it('retorna true para omissão', () => {
    expect(needsPractice(makeWord('omission', null))).toBe(true);
  });

  it('retorna true para mispronunciation mesmo com score alto', () => {
    expect(needsPractice(makeWord('mispronunciation', 95))).toBe(true);
  });
});

// ── categoryFromBand ──────────────────────────────────────────────────────────

describe('categoryFromBand', () => {
  it('good → boa', () => expect(categoryFromBand('good')).toBe('boa'));
  it('attention → pode-melhorar', () => expect(categoryFromBand('attention')).toBe('pode-melhorar'));
  it('practice → pratique', () => expect(categoryFromBand('practice')).toBe('pratique'));
  it('omission → pratique', () => expect(categoryFromBand('omission')).toBe('pratique'));
  it('insertion → pratique', () => expect(categoryFromBand('insertion')).toBe('pratique'));
  it('no_data → pratique', () => expect(categoryFromBand('no_data')).toBe('pratique'));
});
