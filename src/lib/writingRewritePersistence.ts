import type { SupabaseClient } from '@supabase/supabase-js';
import type { WritingRewriteEvaluation, RewriteEvidenceCandidate } from '../domain/writing-rewrite/rewrite-types';
import type { CreateEvaluationInput } from './writingRewriteEvaluationRepository';
import { createRewriteEvaluation } from './writingRewriteEvaluationRepository';

export interface PersistEvaluationInput {
  evaluation: CreateEvaluationInput;
  evidenceCandidates: Array<Omit<RewriteEvidenceCandidate, 'id' | 'createdAt'>>;
}

export interface PersistEvaluationResult {
  evaluation: WritingRewriteEvaluation;
  evidenceCount: number;
}

/**
 * Persist evaluation + outcomes + evidence candidates in sequence.
 * If any step fails, partial data may exist but is not rolled back
 * (Supabase JS client does not support true transactions).
 * Idempotency is handled upstream by the orchestrator.
 */
export async function persistRewriteEvaluation(
  supabase: SupabaseClient,
  input: PersistEvaluationInput,
): Promise<PersistEvaluationResult> {
  // Step 1: Create evaluation + correction outcomes (handled together in repository)
  const evaluation = await createRewriteEvaluation(supabase, input.evaluation);

  // Step 2: Persist evidence candidates
  let evidenceCount = 0;
  if (input.evidenceCandidates.length > 0) {
    evidenceCount = await persistEvidenceCandidates(supabase, input.evidenceCandidates);
  }

  return { evaluation, evidenceCount };
}

/**
 * Insert evidence candidates.
 * ON CONFLICT (review_id, correction_id, evidence_type, rewrite_submission_id) DO NOTHING.
 * Returns the number successfully inserted.
 */
export async function persistEvidenceCandidates(
  supabase: SupabaseClient,
  candidates: Array<Omit<RewriteEvidenceCandidate, 'id' | 'createdAt'>>,
): Promise<number> {
  if (candidates.length === 0) return 0;

  const rows = candidates.map(c => ({
    user_id: c.userId,
    rewrite_submission_id: c.rewriteSubmissionId,
    review_id: c.reviewId,
    correction_id: c.correctionId ?? null,
    grammar_topic_id: c.grammarTopicId ?? null,
    evidence_type: c.evidenceType,
    independence_assessment: c.independenceAssessment,
    confidence: c.confidence,
    should_affect_mastery: c.shouldAffectMastery,
    context_key: c.contextKey,
  }));

  const { data, error } = await supabase
    .from('writing_rewrite_evidence_candidates')
    .upsert(rows, {
      onConflict: 'review_id,correction_id,evidence_type,rewrite_submission_id',
      ignoreDuplicates: true,
    })
    .select('id');

  if (error) throw new Error(`Failed to persist evidence candidates: ${error.message}`);
  return (data as unknown[]).length;
}
