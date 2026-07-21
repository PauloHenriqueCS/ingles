/**
 * Adapts the canonical writing-rewrite evaluation DTO (PublicWritingRewriteDTO
 * — api/writing-rewrite-evaluate.ts, src/lib/writingRewriteOrchestrator.ts)
 * into the legacy RewriteComparisonResult shape RewriteSection.tsx already
 * renders. Pure, no I/O — exists so the UI's visual contract (score,
 * fixed/remaining mistake lists, new issues, feedback) stays unchanged while
 * the underlying evaluation now comes from the canonical engine instead of
 * the old /api/compare-rewrite endpoint.
 */

import type { PublicWritingRewriteDTO } from '../domain/writing-rewrite/rewrite-public-dto';
import type { RewriteComparisonResult } from '../types';

// The legacy AI's own fallback when it didn't produce a nextAction
// (api/compare-rewrite.ts: `String(parsed.nextAction || 'Continue praticando!')`)
// — the canonical evaluation schema has no equivalent field, so this is the
// same static copy previously shown whenever the model omitted one, not new
// or invented content.
const DEFAULT_NEXT_ACTION = 'Continue praticando!';

// 'corrected' and 'valid_alternative' are the only statuses that mean the
// learner actually resolved the mistake independently (or with an equally
// valid alternative phrasing) — see writingRewriteModelEvaluator.ts's
// EVALUATION_RULES prompt section for the authoritative definition of each
// status. 'not_applicable' (sentence restructured, correction no longer
// relevant) is shown in neither bucket, matching how the legacy AI never
// listed a mistake it considered moot.
const FIXED_STATUSES: ReadonlySet<string> = new Set(['corrected', 'valid_alternative']);

export function mapRewriteEvaluationToComparisonResult(dto: PublicWritingRewriteDTO): RewriteComparisonResult {
  const evaluation = dto.evaluation;
  if (!evaluation) {
    // Defensive only — the caller only invokes this once dto.status is
    // 'evaluated', which always carries a non-null evaluation.
    return {
      improvementScore: 0,
      fixedMistakesCount: 0,
      remainingMistakesCount: 0,
      fixedMistakes: [],
      remainingMistakes: [],
      newIssues: [],
      overallFeedback: '',
      nextAction: DEFAULT_NEXT_ACTION,
    };
  }

  const fixedMistakes: RewriteComparisonResult['fixedMistakes'] = [];
  const remainingMistakes: RewriteComparisonResult['remainingMistakes'] = [];

  for (const outcome of evaluation.correctionOutcomes) {
    if (FIXED_STATUSES.has(outcome.status)) {
      fixedMistakes.push({
        mistake: outcome.originalExcerpt,
        original: outcome.originalExcerpt,
        rewrite: outcome.rewriteExcerpt ?? '',
        feedback: outcome.explanationPtBR,
      });
    } else if (outcome.status !== 'not_applicable') {
      remainingMistakes.push({
        mistake: outcome.originalExcerpt,
        rewrite: outcome.rewriteExcerpt ?? '',
        correct: outcome.expectedCorrection,
        feedback: outcome.explanationPtBR,
      });
    }
  }

  const newIssues = evaluation.newIssues.map((issue) => ({
    issue: issue.explanationPtBR,
    rewrite: issue.excerpt ?? '',
    suggestion: '',
  }));

  return {
    improvementScore: evaluation.overallImprovementScore,
    fixedMistakesCount: fixedMistakes.length,
    remainingMistakesCount: remainingMistakes.length,
    fixedMistakes,
    remainingMistakes,
    newIssues,
    overallFeedback: evaluation.summaryPtBR,
    nextAction: DEFAULT_NEXT_ACTION,
  };
}
