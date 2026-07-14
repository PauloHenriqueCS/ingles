/**
 * SERVER-ONLY: loads evidence candidates from writing_rewrite_evidence_candidates
 * and any future review evidence tables.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RawEvidenceCandidate {
  id: string;
  userId: string;
  sourceType: 'rewrite_evaluation' | 'original_review';
  sourceId: string;           // rewrite_submission_id or review_id
  reviewId: string;
  correctionId?: string;
  grammarTopicId?: string;    // may be null if not topic-specific
  evidenceType: string;
  independenceAssessment: string;
  confidence: number;
  shouldAffectMastery: boolean;
  contextKey: string;
  createdAt: string;
  processed: boolean;         // already processed?
}

function rowToCandidate(
  row: Record<string, unknown>,
  sourceType: 'rewrite_evaluation' | 'original_review',
): RawEvidenceCandidate {
  const rewriteSubmissionId = row.rewrite_submission_id != null ? String(row.rewrite_submission_id) : null;
  const reviewId = row.review_id != null ? String(row.review_id) : '';

  return {
    id: String(row.id),
    userId: String(row.user_id),
    sourceType,
    sourceId: sourceType === 'rewrite_evaluation'
      ? (rewriteSubmissionId ?? String(row.id))
      : reviewId,
    reviewId,
    correctionId: row.correction_id != null ? String(row.correction_id) : undefined,
    grammarTopicId: row.grammar_topic_id != null ? String(row.grammar_topic_id) : undefined,
    evidenceType: String(row.evidence_type),
    independenceAssessment: String(row.independence_assessment ?? 'uncertain'),
    confidence: Number(row.confidence ?? 0.5),
    shouldAffectMastery: Boolean(row.should_affect_mastery),
    contextKey: String(row.context_key ?? ''),
    createdAt: String(row.created_at),
    processed: row.processed_at != null,
  };
}

// Load unprocessed rewrite evidence candidates for a given rewrite submission
export async function loadUnprocessedRewriteCandidates(
  supabase: SupabaseClient,
  rewriteSubmissionId: string,
): Promise<RawEvidenceCandidate[]> {
  const { data, error } = await supabase
    .from('writing_rewrite_evidence_candidates')
    .select('*')
    .eq('rewrite_submission_id', rewriteSubmissionId)
    .is('processed_at', null);

  if (error) throw new Error(`loadUnprocessedRewriteCandidates: ${error.message}`);
  return (data ?? []).map(row => rowToCandidate(row as Record<string, unknown>, 'rewrite_evaluation'));
}

// Load unprocessed review evidence candidates (from original_review source)
export async function loadUnprocessedReviewCandidates(
  supabase: SupabaseClient,
  reviewId: string,
): Promise<RawEvidenceCandidate[]> {
  const { data, error } = await supabase
    .from('writing_rewrite_evidence_candidates')
    .select('*')
    .eq('review_id', reviewId)
    .is('processed_at', null);

  if (error) throw new Error(`loadUnprocessedReviewCandidates: ${error.message}`);
  return (data ?? []).map(row => rowToCandidate(row as Record<string, unknown>, 'original_review'));
}

// Mark a candidate as processed (update processed_at)
export async function markCandidateProcessed(
  supabase: SupabaseClient,
  candidateId: string,
  _sourceType: 'rewrite_evaluation' | 'original_review',
): Promise<void> {
  const { error } = await supabase
    .from('writing_rewrite_evidence_candidates')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', candidateId);

  if (error) throw new Error(`markCandidateProcessed: ${error.message}`);
}
