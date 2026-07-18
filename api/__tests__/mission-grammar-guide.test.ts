import { describe, it, expect } from 'vitest';
import { normalizeGrammarGuide, normalizeOptionalExercises } from '../_mission-grammar-guide';

const VALID_GUIDE = {
  title: 'Present Perfect',
  explanationPtBr: 'Use o Present Perfect para falar de ações passadas com relevância no presente.',
  usagePtBr: ['Experiências de vida', 'Mudanças recentes'],
  structures: {
    affirmative: 'Subject + have/has + past participle',
    negative: 'Subject + have/has not + past participle',
    interrogative: 'Have/Has + subject + past participle?',
  },
  examples: [{ english: 'I have finished the report.', portuguese: 'Eu terminei o relatório.' }],
  commonMistakes: ['Usar Present Perfect com datas específicas no passado.'],
};

const VALID_EXERCISES = [
  { id: 'ex1', type: 'fill_blank', instructionPtBr: 'Complete a frase.', question: 'I ___ (finish) my homework.', correctAnswer: 'have finished', explanationPtBr: 'Present Perfect afirmativo.' },
  { id: 'ex2', type: 'multiple_choice', instructionPtBr: 'Escolha a certa.', question: 'She ___ to Paris.', options: ['have been', 'has been', 'had been'], correctAnswer: 'has been', explanationPtBr: 'Terceira pessoa usa "has".' },
  { id: 'ex3', type: 'transform_sentence', instructionPtBr: 'Transforme para negativa.', question: 'I have seen this movie.', correctAnswer: 'I have not seen this movie.', explanationPtBr: 'Negativa com "not" após "have".' },
  { id: 'ex4', type: 'correct_error', instructionPtBr: 'Corrija o erro.', question: 'She have finished.', correctAnswer: 'She has finished.', explanationPtBr: 'Terceira pessoa usa "has".' },
  { id: 'ex5', type: 'translate', instructionPtBr: 'Traduza.', question: 'Eu já vi esse filme.', correctAnswer: 'I have already seen this movie.', explanationPtBr: 'Present Perfect com "already".' },
];

describe('normalizeGrammarGuide', () => {
  it('returns a fully populated guide for valid input', () => {
    const result = normalizeGrammarGuide(VALID_GUIDE);
    expect(result).toEqual(VALID_GUIDE);
  });

  it('returns null when input is missing entirely', () => {
    expect(normalizeGrammarGuide(undefined)).toBeNull();
    expect(normalizeGrammarGuide(null)).toBeNull();
  });

  it('returns null when title is missing', () => {
    const { title, ...rest } = VALID_GUIDE;
    expect(normalizeGrammarGuide(rest)).toBeNull();
  });

  it('returns null when structures are incomplete', () => {
    expect(normalizeGrammarGuide({ ...VALID_GUIDE, structures: { affirmative: 'x' } })).toBeNull();
  });

  it('returns null when there are no valid examples', () => {
    expect(normalizeGrammarGuide({ ...VALID_GUIDE, examples: [] })).toBeNull();
  });

  it('filters out malformed examples but keeps valid ones', () => {
    const result = normalizeGrammarGuide({
      ...VALID_GUIDE,
      examples: [{ english: '', portuguese: 'x' }, { english: 'I have gone.', portuguese: 'Eu fui.' }],
    });
    expect(result?.examples).toEqual([{ english: 'I have gone.', portuguese: 'Eu fui.' }]);
  });

  it('defaults usagePtBr and commonMistakes to empty arrays when absent', () => {
    const { usagePtBr, commonMistakes, ...rest } = VALID_GUIDE;
    const result = normalizeGrammarGuide(rest);
    expect(result?.usagePtBr).toEqual([]);
    expect(result?.commonMistakes).toEqual([]);
  });
});

describe('normalizeOptionalExercises', () => {
  it('returns all 5 valid exercises unchanged', () => {
    const result = normalizeOptionalExercises(VALID_EXERCISES);
    expect(result).toHaveLength(5);
    expect(result?.[1].options).toEqual(['have been', 'has been', 'had been']);
  });

  it('returns null when input is not an array', () => {
    expect(normalizeOptionalExercises(undefined)).toBeNull();
    expect(normalizeOptionalExercises({})).toBeNull();
  });

  it('returns null when the array is empty', () => {
    expect(normalizeOptionalExercises([])).toBeNull();
  });

  it('drops entries with an invalid type', () => {
    const result = normalizeOptionalExercises([
      { ...VALID_EXERCISES[0], type: 'not_a_real_type' },
      VALID_EXERCISES[1],
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe('ex2');
  });

  it('drops multiple_choice entries with fewer than 2 options', () => {
    const result = normalizeOptionalExercises([
      { ...VALID_EXERCISES[1], options: ['only one'] },
      VALID_EXERCISES[0],
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0].type).toBe('fill_blank');
  });

  it('drops entries missing required string fields', () => {
    const result = normalizeOptionalExercises([
      { ...VALID_EXERCISES[0], correctAnswer: '' },
      VALID_EXERCISES[2],
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe('ex3');
  });

  it('deduplicates ids by falling back to a positional id', () => {
    const result = normalizeOptionalExercises([
      { ...VALID_EXERCISES[0], id: 'dup' },
      { ...VALID_EXERCISES[2], id: 'dup' },
    ]);
    expect(result).toHaveLength(2);
    expect(new Set(result?.map((e) => e.id)).size).toBe(2);
  });
});
