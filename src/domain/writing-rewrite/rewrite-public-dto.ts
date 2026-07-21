/**
 * Public DTO builder for writing rewrite responses.
 * Strips all internal fields: raw model output, copy signals, evidence candidates,
 * costs, prompt internals, grammar mastery internals, per-signal confidence.
 */

import type {
  WritingRewriteAttempt,
  WritingRewriteEvaluation,
  RewriteCorrectionOutcome,
  RewriteIndependenceAssessment,
} from './rewrite-types';
import type { RewriteStatus } from './rewrite-status';

export interface PublicWritingRewriteDTO {
  rewriteSubmissionId: string;
  status: 'draft' | 'submitted' | 'pending' | 'evaluated' | 'failed';
  originalText: string;
  correctedText: string;
  rewriteText: string | null;
  evaluation: {
    overallImprovementScore: number;
    correctionResolutionScore: number;
    newErrorAvoidanceScore: number;
    meaningPreservationScore: number;
    clarityImprovementScore: number;
    cohesionImprovementScore: number;
    independenceScore: number;
    independenceAssessment: RewriteIndependenceAssessment;
    summaryPtBR: string;
    correctionOutcomes: Array<{
      correctionId: string;
      status: RewriteCorrectionOutcome['status'];
      // Already user-facing excerpts computed server-side (never raw model
      // JSON, never internal confidence/copy-signal fields) — exposed so a
      // caller can render "you wrote X, correct form Y, your rewrite Z"
      // without needing its own client-side copy of the original mistakes.
      originalExcerpt: string;
      expectedCorrection: string;
      rewriteExcerpt?: string;
      explanationPtBR: string;
    }>;
    newIssues: Array<{
      category: string;
      excerpt?: string;
      explanationPtBR: string;
    }>;
  } | null;
  createdAt: string;
  submittedAt: string | null;
}

function mapStatus(status: RewriteStatus): PublicWritingRewriteDTO['status'] {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'submitted':
      return 'submitted';
    case 'evaluation_pending':
      return 'pending';
    case 'evaluated':
      return 'evaluated';
    case 'evaluation_failed':
      return 'failed';
    case 'superseded':
      return 'submitted'; // backward compat
    case 'cancelled':
      return 'draft';
    default: {
      const exhaustiveCheck: never = status;
      return exhaustiveCheck;
    }
  }
}

export function buildPublicRewriteDTO(
  attempt: WritingRewriteAttempt,
  originalText: string,
  correctedText: string,
  evaluation: WritingRewriteEvaluation | null,
): PublicWritingRewriteDTO {
  return {
    rewriteSubmissionId: attempt.id,
    status: mapStatus(attempt.status),
    originalText,
    correctedText,
    rewriteText: attempt.rewriteText,
    evaluation: evaluation
      ? {
          overallImprovementScore: evaluation.scores.overallImprovementScore,
          correctionResolutionScore: evaluation.scores.correctionResolutionScore,
          newErrorAvoidanceScore: evaluation.scores.newErrorAvoidanceScore,
          meaningPreservationScore: evaluation.scores.meaningPreservationScore,
          clarityImprovementScore: evaluation.scores.clarityImprovementScore,
          cohesionImprovementScore: evaluation.scores.cohesionImprovementScore,
          independenceScore: evaluation.scores.independenceScore,
          independenceAssessment: evaluation.independenceAssessment,
          summaryPtBR: evaluation.summaryPtBR,
          correctionOutcomes: evaluation.correctionOutcomes.map(o => ({
            correctionId: o.correctionId,
            status: o.status,
            originalExcerpt: o.originalExcerpt,
            expectedCorrection: o.expectedCorrection,
            rewriteExcerpt: o.rewriteExcerpt,
            explanationPtBR: o.explanationPtBR,
          })),
          newIssues: evaluation.newIssues.map(issue => ({
            category: issue.category,
            excerpt: issue.excerpt,
            explanationPtBR: issue.explanationPtBR,
          })),
        }
      : null,
    createdAt: attempt.createdAt,
    submittedAt: attempt.submittedAt ?? null,
  };
}
