import type { RewriteIndependenceAssessment } from '../domain/writing-rewrite/rewrite-types';

export type RewriteEventType =
  | 'rewrite_draft_created'
  | 'rewrite_submitted'
  | 'rewrite_submission_rejected'
  | 'rewrite_evaluation_created'
  | 'rewrite_evaluation_processing_started'
  | 'rewrite_evaluation_idempotent_replay'
  | 'rewrite_deterministic_comparison_completed'
  | 'rewrite_model_called'
  | 'rewrite_model_succeeded'
  | 'rewrite_model_failed'
  | 'rewrite_copy_signal_detected'
  | 'rewrite_correction_outcomes_created'
  | 'rewrite_evidence_candidates_created'
  | 'rewrite_evaluation_completed'
  | 'rewrite_evaluation_failed'
  | 'rewrite_shadow_comparison_completed';

export interface RewriteEventPayload {
  event: RewriteEventType;
  rewriteSubmissionId?: string;
  originalSubmissionId?: string;
  reviewId?: string;
  missionId?: string;
  requestId?: string;
  evaluationVersion?: number;
  scoringVersion?: string;
  featureFlagMode?: string;
  latencyMs?: number;
  tokens?: number;
  cost?: number;
  independenceAssessment?: RewriteIndependenceAssessment;
  errorMessage?: string;
  // NO full texts in logs
}

/**
 * Structured event logging for rewrite pipeline.
 * Never logs originalText, correctedText, or rewriteText.
 */
export function logRewriteEvent(payload: RewriteEventPayload): void {
  console.log(JSON.stringify({ ...payload, ts: new Date().toISOString() }));
}
