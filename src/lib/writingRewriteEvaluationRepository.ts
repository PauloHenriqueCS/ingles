import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  WritingRewriteEvaluation,
  RewriteCorrectionOutcome,
  NewIssue,
  RewriteScoreComponents,
  RewriteIndependenceAssessment,
  RewriteEvaluationStatus,
} from '../domain/writing-rewrite/rewrite-types';

export interface CreateEvaluationInput {
  userId: string;
  missionId?: string;
  originalSubmissionId: string;
  rewriteSubmissionId: string;
  reviewId: string;
  evaluationVersion: number;
  scores: RewriteScoreComponents;
  independenceAssessment: RewriteIndependenceAssessment;
  summaryPtBR: string;
  correctionOutcomes: RewriteCorrectionOutcome[];
  newIssues: NewIssue[];
  scoringVersion: string;
  schemaVersion: string;
  promptVersion?: string;
  modelProvider?: string;
  modelName?: string;
}

function rowToEvaluation(row: Record<string, unknown>): WritingRewriteEvaluation {
  const scores: RewriteScoreComponents = {
    correctionResolutionScore: row.correction_resolution_score as number,
    newErrorAvoidanceScore: row.new_error_avoidance_score as number,
    meaningPreservationScore: row.meaning_preservation_score as number,
    clarityImprovementScore: row.clarity_improvement_score as number,
    cohesionImprovementScore: row.cohesion_improvement_score as number,
    independenceScore: row.independence_score as number,
    overallImprovementScore: row.overall_improvement_score as number,
  };

  return {
    id: row.id as string,
    userId: row.user_id as string,
    missionId: row.mission_id as string | undefined,
    originalSubmissionId: row.original_submission_id as string,
    rewriteSubmissionId: row.rewrite_submission_id as string,
    reviewId: row.review_id as string,
    evaluationVersion: row.evaluation_version as number,
    status: row.status as RewriteEvaluationStatus,
    scores,
    independenceAssessment: row.independence_assessment as RewriteIndependenceAssessment,
    summaryPtBR: (row.summary_pt_br as string) ?? '',
    correctionOutcomes: [], // loaded separately via getCorrectionOutcomesForEvaluation
    newIssues: (row.new_issues_json as NewIssue[]) ?? [],
    scoringVersion: row.scoring_version as string,
    schemaVersion: row.schema_version as string,
    promptVersion: row.prompt_version as string | undefined,
    modelProvider: row.model_provider as string | undefined,
    modelName: row.model_name as string | undefined,
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | undefined,
  };
}

export async function createRewriteEvaluation(
  supabase: SupabaseClient,
  input: CreateEvaluationInput,
): Promise<WritingRewriteEvaluation> {
  const { data, error } = await supabase
    .from('writing_rewrite_evaluations')
    .insert({
      user_id: input.userId,
      mission_id: input.missionId ?? null,
      original_submission_id: input.originalSubmissionId,
      rewrite_submission_id: input.rewriteSubmissionId,
      review_id: input.reviewId,
      evaluation_version: input.evaluationVersion,
      status: 'pending',
      correction_resolution_score: input.scores.correctionResolutionScore,
      new_error_avoidance_score: input.scores.newErrorAvoidanceScore,
      meaning_preservation_score: input.scores.meaningPreservationScore,
      clarity_improvement_score: input.scores.clarityImprovementScore,
      cohesion_improvement_score: input.scores.cohesionImprovementScore,
      independence_score: input.scores.independenceScore,
      overall_improvement_score: input.scores.overallImprovementScore,
      independence_assessment: input.independenceAssessment,
      summary_pt_br: input.summaryPtBR,
      new_issues_json: input.newIssues,
      scoring_version: input.scoringVersion,
      schema_version: input.schemaVersion,
      prompt_version: input.promptVersion ?? null,
      model_provider: input.modelProvider ?? null,
      model_name: input.modelName ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create rewrite evaluation: ${error.message}`);

  const evaluation = rowToEvaluation(data as Record<string, unknown>);

  // Persist correction outcomes in the same call
  if (input.correctionOutcomes.length > 0) {
    const outcomesInsert = input.correctionOutcomes.map(o => ({
      rewrite_evaluation_id: evaluation.id,
      correction_id: o.correctionId,
      status: o.status,
      original_excerpt: o.originalExcerpt,
      expected_correction: o.expectedCorrection,
      rewrite_excerpt: o.rewriteExcerpt ?? null,
      explanation_pt_br: o.explanationPtBR,
      confidence: o.confidence,
      should_affect_score: o.shouldAffectRewriteScore,
    }));

    const { error: outcomesError } = await supabase
      .from('writing_rewrite_correction_outcomes')
      .insert(outcomesInsert);

    if (outcomesError) {
      throw new Error(`Failed to create correction outcomes: ${outcomesError.message}`);
    }
  }

  evaluation.correctionOutcomes = input.correctionOutcomes;
  return evaluation;
}

export async function getEvaluationForAttempt(
  supabase: SupabaseClient,
  rewriteSubmissionId: string,
  evaluationVersion?: number,
): Promise<WritingRewriteEvaluation | null> {
  let query = supabase
    .from('writing_rewrite_evaluations')
    .select('*')
    .eq('rewrite_submission_id', rewriteSubmissionId);

  if (evaluationVersion !== undefined) {
    query = query.eq('evaluation_version', evaluationVersion);
  } else {
    query = query.order('evaluation_version', { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();

  if (error) throw new Error(`Failed to get rewrite evaluation: ${error.message}`);
  if (!data) return null;

  const evaluation = rowToEvaluation(data as Record<string, unknown>);
  evaluation.correctionOutcomes = await getCorrectionOutcomesForEvaluation(supabase, evaluation.id);
  return evaluation;
}

export async function updateEvaluationStatus(
  supabase: SupabaseClient,
  evaluationId: string,
  status: RewriteEvaluationStatus,
  completedAt?: string,
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (completedAt !== undefined) update.completed_at = completedAt;

  const { error } = await supabase
    .from('writing_rewrite_evaluations')
    .update(update)
    .eq('id', evaluationId);

  if (error) throw new Error(`Failed to update evaluation status: ${error.message}`);
}

export async function getCorrectionOutcomesForEvaluation(
  supabase: SupabaseClient,
  evaluationId: string,
): Promise<RewriteCorrectionOutcome[]> {
  const { data, error } = await supabase
    .from('writing_rewrite_correction_outcomes')
    .select('*')
    .eq('rewrite_evaluation_id', evaluationId)
    .order('correction_id', { ascending: true });

  if (error) throw new Error(`Failed to get correction outcomes: ${error.message}`);

  return (data as Record<string, unknown>[]).map(row => ({
    correctionId: row.correction_id as string,
    status: row.status as RewriteCorrectionOutcome['status'],
    originalExcerpt: row.original_excerpt as string,
    expectedCorrection: row.expected_correction as string,
    rewriteExcerpt: row.rewrite_excerpt as string | undefined,
    explanationPtBR: row.explanation_pt_br as string,
    confidence: row.confidence as number,
    shouldAffectRewriteScore: row.should_affect_score as boolean,
  }));
}
