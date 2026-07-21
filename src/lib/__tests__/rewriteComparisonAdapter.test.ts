import { describe, it, expect } from 'vitest';
import { mapRewriteEvaluationToComparisonResult } from '../rewriteComparisonAdapter';
import type { PublicWritingRewriteDTO } from '../../domain/writing-rewrite/rewrite-public-dto';

function baseDto(overrides: Partial<NonNullable<PublicWritingRewriteDTO['evaluation']>> = {}): PublicWritingRewriteDTO {
  return {
    rewriteSubmissionId: 'attempt-1',
    status: 'evaluated',
    originalText: 'Yesterday I goed to the store.',
    correctedText: 'Yesterday I went to the store.',
    rewriteText: 'Yesterday I went to the store and buyed bread.',
    evaluation: {
      overallImprovementScore: 78,
      correctionResolutionScore: 90,
      newErrorAvoidanceScore: 80,
      meaningPreservationScore: 90,
      clarityImprovementScore: 70,
      cohesionImprovementScore: 60,
      independenceScore: 85,
      independenceAssessment: 'independent',
      summaryPtBR: 'Você melhorou bastante, mas ainda há um erro.',
      correctionOutcomes: [],
      newIssues: [],
      ...overrides,
    },
    createdAt: '2026-07-21T00:00:00.000Z',
    submittedAt: '2026-07-21T00:00:01.000Z',
  };
}

describe('mapRewriteEvaluationToComparisonResult', () => {
  it('maps overallImprovementScore to improvementScore and summaryPtBR to overallFeedback', () => {
    const result = mapRewriteEvaluationToComparisonResult(baseDto());
    expect(result.improvementScore).toBe(78);
    expect(result.overallFeedback).toBe('Você melhorou bastante, mas ainda há um erro.');
  });

  it('always provides a non-empty nextAction (schema has no equivalent field — static fallback)', () => {
    const result = mapRewriteEvaluationToComparisonResult(baseDto());
    expect(result.nextAction).toBeTruthy();
  });

  it('buckets "corrected" and "valid_alternative" statuses into fixedMistakes', () => {
    const dto = baseDto({
      correctionOutcomes: [
        { correctionId: '0', status: 'corrected', originalExcerpt: 'goed', expectedCorrection: 'went', rewriteExcerpt: 'went', explanationPtBR: 'Corrigido.' },
        { correctionId: '1', status: 'valid_alternative', originalExcerpt: 'a lot of', expectedCorrection: 'many', rewriteExcerpt: 'plenty of', explanationPtBR: 'Alternativa válida.' },
      ],
    });
    const result = mapRewriteEvaluationToComparisonResult(dto);
    expect(result.fixedMistakesCount).toBe(2);
    expect(result.remainingMistakesCount).toBe(0);
    expect(result.fixedMistakes).toEqual([
      { mistake: 'goed', original: 'goed', rewrite: 'went', feedback: 'Corrigido.' },
      { mistake: 'a lot of', original: 'a lot of', rewrite: 'plenty of', feedback: 'Alternativa válida.' },
    ]);
  });

  it('buckets "unchanged", "partially_corrected", and "worsened" statuses into remainingMistakes', () => {
    const dto = baseDto({
      correctionOutcomes: [
        { correctionId: '0', status: 'unchanged', originalExcerpt: 'goed', expectedCorrection: 'went', rewriteExcerpt: 'goed', explanationPtBR: 'Não corrigido.' },
        { correctionId: '1', status: 'partially_corrected', originalExcerpt: 'buyed', expectedCorrection: 'bought', rewriteExcerpt: 'buyed some', explanationPtBR: 'Parcial.' },
        { correctionId: '2', status: 'worsened', originalExcerpt: 'runned', expectedCorrection: 'ran', rewriteExcerpt: 'runnned', explanationPtBR: 'Piorou.' },
      ],
    });
    const result = mapRewriteEvaluationToComparisonResult(dto);
    expect(result.remainingMistakesCount).toBe(3);
    expect(result.fixedMistakesCount).toBe(0);
    expect(result.remainingMistakes).toEqual([
      { mistake: 'goed', rewrite: 'goed', correct: 'went', feedback: 'Não corrigido.' },
      { mistake: 'buyed', rewrite: 'buyed some', correct: 'bought', feedback: 'Parcial.' },
      { mistake: 'runned', rewrite: 'runnned', correct: 'ran', feedback: 'Piorou.' },
    ]);
  });

  it('omits "not_applicable" outcomes from both fixed and remaining buckets', () => {
    const dto = baseDto({
      correctionOutcomes: [
        { correctionId: '0', status: 'not_applicable', originalExcerpt: 'goed', expectedCorrection: 'went', explanationPtBR: 'Reestruturado.' },
      ],
    });
    const result = mapRewriteEvaluationToComparisonResult(dto);
    expect(result.fixedMistakesCount).toBe(0);
    expect(result.remainingMistakesCount).toBe(0);
  });

  it('falls back to an empty string when rewriteExcerpt is absent, never undefined in the output', () => {
    const dto = baseDto({
      correctionOutcomes: [
        { correctionId: '0', status: 'corrected', originalExcerpt: 'goed', expectedCorrection: 'went', explanationPtBR: 'Corrigido.' },
      ],
    });
    const result = mapRewriteEvaluationToComparisonResult(dto);
    expect(result.fixedMistakes[0].rewrite).toBe('');
  });

  it('maps newIssues, using explanationPtBR as the issue line and excerpt as the rewrite quote', () => {
    const dto = baseDto({
      newIssues: [{ category: 'new_grammar_error', excerpt: 'a new mistake', explanationPtBR: 'Novo erro de gramática.' }],
    });
    const result = mapRewriteEvaluationToComparisonResult(dto);
    expect(result.newIssues).toEqual([{ issue: 'Novo erro de gramática.', rewrite: 'a new mistake', suggestion: '' }]);
  });

  it('returns a safe empty-shaped result if evaluation is null (defensive — should not occur for an evaluated DTO)', () => {
    const dto: PublicWritingRewriteDTO = { ...baseDto(), evaluation: null };
    const result = mapRewriteEvaluationToComparisonResult(dto);
    expect(result.improvementScore).toBe(0);
    expect(result.fixedMistakes).toEqual([]);
    expect(result.remainingMistakes).toEqual([]);
    expect(result.newIssues).toEqual([]);
  });
});
