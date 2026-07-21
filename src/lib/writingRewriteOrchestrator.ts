/**
 * Main server-side orchestrator for writing rewrite evaluation.
 *
 * Security rules enforced here:
 * - Scores are NEVER accepted from the client
 * - userId is derived from the session (passed as authenticatedUserId)
 * - reviewId ownership is validated against authenticatedUserId
 * - originalSubmissionId is always english_reviews.id (same as reviewId)
 * - Mission completion is NOT triggered by this flow
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicWritingRewriteDTO } from '../domain/writing-rewrite/rewrite-public-dto';
import type { MainMistake } from './writingRewriteDeterministicComparison';
import type { RewriteEvidenceCandidate } from '../domain/writing-rewrite/rewrite-types';

import { buildPublicRewriteDTO } from '../domain/writing-rewrite/rewrite-public-dto';
import {
  buildRewriteScoreComponents,
  adjustedIndependenceScore,
  CURRENT_SCORING_VERSION,
} from '../domain/writing-rewrite/rewrite-score-calculation';
import { calculateCorrectionResolutionScore } from '../domain/writing-rewrite/rewrite-correction-outcomes';
import { shouldAffectMastery, buildContextKey } from '../domain/writing-rewrite/rewrite-evidence-types';

import {
  getRewriteAttemptById,
  updateRewriteAttemptStatus,
} from './writingRewriteRepository';
import {
  updateEvaluationStatus,
} from './writingRewriteEvaluationRepository';
import { checkRewriteEvaluationIdempotency } from './writingRewriteIdempotency';
import { persistRewriteEvaluation } from './writingRewritePersistence';
import { runDeterministicComparison } from './writingRewriteDeterministicComparison';
import { callModelEvaluator, buildRewriteEvaluationPrompt, type ModelEvaluationOutput } from './writingRewriteModelEvaluator';
import { logRewriteEvent } from './writingRewriteObservability';
import {
  executeAiGatewayCall,
  getProductionDeps,
  estimateTextTokens,
  type GatewayUsageMetric,
} from '../../api/_ai-gateway/index';

const MODEL_EVALUATOR_MAX_OUTPUT_TOKENS = 2048; // matches the real max_tokens passed to OpenAI in writingRewriteModelEvaluator.ts

/**
 * Reads real token usage from the provider response (writingRewriteModelEvaluator
 * captures it from the same HTTP response the evaluation content comes from —
 * never a second call). Falls back to just provider_requests if usage is
 * unavailable (e.g. a provider response shape change), matching how every
 * other extractor in this codebase degrades when `.usage` is absent.
 */
function extractRewriteEvaluatorMetrics(result: ModelEvaluationOutput): GatewayUsageMetric[] {
  const metrics: GatewayUsageMetric[] = [
    { metricKey: 'provider_requests', unitType: 'request', quantity: 1, isBillable: false, measurementSource: 'provider_response' },
  ];
  if (result.usage?.promptTokens != null) {
    metrics.push({ metricKey: 'input_text_tokens', unitType: 'token', quantity: result.usage.promptTokens, isBillable: true, measurementSource: 'provider_response' });
  }
  if (result.usage?.completionTokens != null) {
    metrics.push({ metricKey: 'output_text_tokens', unitType: 'token', quantity: result.usage.completionTokens, isBillable: true, measurementSource: 'provider_response' });
  }
  return metrics;
}

export interface EvaluateWritingRewriteInput {
  authenticatedUserId: string;
  rewriteSubmissionId: string;
  clientRequestId: string;
}

export async function evaluateWritingRewrite(
  supabase: SupabaseClient,
  input: EvaluateWritingRewriteInput,
): Promise<PublicWritingRewriteDTO> {
  const { authenticatedUserId, rewriteSubmissionId, clientRequestId } = input;

  const startMs = Date.now();

  // ── Step 1: Load the rewrite attempt, verify ownership ───────────────────
  const attempt = await getRewriteAttemptById(supabase, rewriteSubmissionId);
  if (!attempt) {
    throw new Error(`Rewrite attempt not found: ${rewriteSubmissionId}`);
  }
  if (attempt.userId !== authenticatedUserId) {
    throw new Error('Unauthorized: rewrite attempt does not belong to this user');
  }

  // ── Step 2: Verify status is evaluable ───────────────────────────────────
  if (
    attempt.status !== 'submitted' &&
    attempt.status !== 'evaluation_failed' &&
    attempt.status !== 'evaluation_pending'
  ) {
    throw new Error(
      `Rewrite attempt in status '${attempt.status}' cannot be evaluated`,
    );
  }

  const evaluationVersion = 1;

  // ── Step 3: Idempotency check ─────────────────────────────────────────────
  const idempotencyResult = await checkRewriteEvaluationIdempotency(
    supabase,
    rewriteSubmissionId,
    evaluationVersion,
  );

  if (idempotencyResult.alreadyProcessed && idempotencyResult.existing) {
    logRewriteEvent({
      event: 'rewrite_evaluation_idempotent_replay',
      rewriteSubmissionId,
      requestId: clientRequestId,
      evaluationVersion,
    });

    // Load review for texts
    const { data: reviewRow } = await supabase
      .from('english_reviews')
      .select('original_text, corrected_text')
      .eq('id', attempt.reviewId)
      .single();

    return buildPublicRewriteDTO(
      attempt,
      (reviewRow as Record<string, string>)?.original_text ?? attempt.originalTextSnapshot,
      (reviewRow as Record<string, string>)?.corrected_text ?? '',
      idempotencyResult.existing,
    );
  }

  // ── Step 4: Transition to evaluation_pending ──────────────────────────────
  logRewriteEvent({
    event: 'rewrite_evaluation_processing_started',
    rewriteSubmissionId,
    reviewId: attempt.reviewId,
    missionId: attempt.missionId,
    requestId: clientRequestId,
    evaluationVersion,
  });

  await updateRewriteAttemptStatus(supabase, rewriteSubmissionId, 'evaluation_pending');

  // ── Step 5: Load the review ───────────────────────────────────────────────
  const { data: reviewRow, error: reviewError } = await supabase
    .from('english_reviews')
    .select('*')
    .eq('id', attempt.reviewId)
    .single();

  if (reviewError || !reviewRow) {
    await updateRewriteAttemptStatus(supabase, rewriteSubmissionId, 'evaluation_failed');
    throw new Error(`Review not found for attempt ${rewriteSubmissionId}: ${reviewError?.message}`);
  }

  const review = reviewRow as Record<string, unknown>;

  // ── Step 6: Security — verify review ownership ────────────────────────────
  if ((review.user_id as string) !== authenticatedUserId) {
    await updateRewriteAttemptStatus(supabase, rewriteSubmissionId, 'cancelled');
    throw new Error('Unauthorized: review does not belong to this user');
  }

  const originalText = (review.original_text as string) ?? attempt.originalTextSnapshot;
  const correctedText = (review.corrected_text as string) ?? '';
  const effectiveLevel = (review.level as string) ?? 'A2';
  const mainMistakesRaw = (review.main_mistakes as unknown[]) ?? [];

  const mainMistakes: MainMistake[] = mainMistakesRaw.map(m => {
    const mm = m as Record<string, string>;
    return {
      mistake: mm.mistake ?? '',
      correct: mm.correct ?? mm.correction ?? '',
      explanation: mm.explanation,
    };
  });

  const rewriteText = attempt.rewriteText ?? '';

  // ── Step 7: Deterministic comparison ─────────────────────────────────────
  const deterministicResult = runDeterministicComparison({
    originalText,
    correctedText,
    rewriteText,
    mainMistakes,
  });

  logRewriteEvent({
    event: 'rewrite_deterministic_comparison_completed',
    rewriteSubmissionId,
    reviewId: attempt.reviewId,
    requestId: clientRequestId,
    independenceAssessment: deterministicResult.layerB.copyDetection.assessment,
  });

  // ── Step 8: Model evaluation — routed through the AI Gateway ──────────────
  // featureKey 'writing.evaluate_rewrite': this IS the real, only physical
  // call that evaluates the V2 rewrite (previously called OpenAI directly
  // via fetch(), bypassing the Gateway entirely — see writingRewriteModelEvaluator.ts).
  // Wrapping it here adds reservation/telemetry/budget tracking without a
  // second AI request: callModelEvaluator's own single fetch() is the
  // `invoke` the Gateway wraps, and its real token usage (already present in
  // that same HTTP response) is what extractRewriteEvaluatorMetrics reports.
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  const modelInput = { originalText, correctedText, rewriteText, mainMistakes, effectiveLevel, deterministicResult };
  const gatewayDeps = getProductionDeps();
  let modelOutput: ModelEvaluationOutput;

  try {
    logRewriteEvent({ event: 'rewrite_model_called', rewriteSubmissionId, requestId: clientRequestId });
    modelOutput = await executeAiGatewayCall<ModelEvaluationOutput>(
      {
        featureKey: 'writing.evaluate_rewrite',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o',
        userId: authenticatedUserId,
        initiatedByUserId: authenticatedUserId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: clientRequestId,
        attemptNumber: 1,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'writing-rewrite-evaluate',
          operation: 'evaluate_rewrite',
        },
        estimatedMetrics: estimateTextTokens(
          buildRewriteEvaluationPrompt(modelInput).length,
          MODEL_EVALUATOR_MAX_OUTPUT_TOKENS,
        ),
      },
      () => callModelEvaluator(modelInput, apiKey),
      gatewayDeps,
      extractRewriteEvaluatorMetrics,
    );
    logRewriteEvent({ event: 'rewrite_model_succeeded', rewriteSubmissionId, requestId: clientRequestId });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logRewriteEvent({
      event: 'rewrite_model_failed',
      rewriteSubmissionId,
      requestId: clientRequestId,
      errorMessage,
    });
    await updateRewriteAttemptStatus(supabase, rewriteSubmissionId, 'evaluation_failed');
    throw new Error(`Model evaluation failed: ${errorMessage}`);
  }

  // ── Step 9: Adjust independence score based on copy detection ────────────
  const copyAssessment = deterministicResult.layerB.copyDetection.assessment;
  const rawIndependenceScore = 100 - Math.round(deterministicResult.layerB.copyDetection.confidence * 100);
  const independenceScore = adjustedIndependenceScore(
    Math.min(100, Math.max(0, rawIndependenceScore)),
    copyAssessment,
  );

  // ── Step 10: Calculate final scores ──────────────────────────────────────
  const correctionResolutionScore = calculateCorrectionResolutionScore(
    modelOutput.correctionOutcomes.map(o => ({
      status: o.status,
      shouldAffectRewriteScore: o.shouldAffectRewriteScore,
    })),
  );

  const newErrorAvoidanceScore = modelOutput.newIssues.length === 0
    ? 100
    : Math.max(0, 100 - modelOutput.newIssues.length * 20);

  const finalScores = buildRewriteScoreComponents({
    correctionResolutionScore,
    newErrorAvoidanceScore,
    meaningPreservationScore: modelOutput.meaningPreservationScore,
    clarityImprovementScore: modelOutput.clarityImprovementScore,
    cohesionImprovementScore: modelOutput.cohesionImprovementScore,
    independenceScore,
    scoringVersion: CURRENT_SCORING_VERSION,
  });

  // ── Step 11: Build correction outcomes ────────────────────────────────────
  const correctionOutcomes = modelOutput.correctionOutcomes.map(o => ({
    correctionId: o.correctionId,
    status: o.status,
    originalExcerpt: mainMistakes[Number(o.correctionId)]?.mistake ?? '',
    expectedCorrection: mainMistakes[Number(o.correctionId)]?.correct ?? '',
    rewriteExcerpt: o.rewriteExcerpt,
    explanationPtBR: o.explanationPtBR,
    confidence: o.confidence,
    shouldAffectRewriteScore: o.shouldAffectRewriteScore,
  }));

  // ── Step 12: Build evidence candidates ───────────────────────────────────
  const evidenceCandidates: Array<Omit<RewriteEvidenceCandidate, 'id' | 'createdAt'>> =
    correctionOutcomes.map(o => {
      const evidenceType =
        o.status === 'corrected' || o.status === 'valid_alternative'
          ? copyAssessment === 'independent' || copyAssessment === 'likely_independent'
            ? ('error_corrected_independently' as const)
            : ('error_corrected_with_possible_copy' as const)
          : o.status === 'unchanged'
          ? ('error_persisted' as const)
          : ('no_independent_evidence' as const);

      return {
        userId: authenticatedUserId,
        rewriteSubmissionId,
        reviewId: attempt.reviewId,
        correctionId: o.correctionId,
        evidenceType,
        independenceAssessment: copyAssessment,
        confidence: o.confidence,
        shouldAffectMastery: shouldAffectMastery(evidenceType, copyAssessment),
        contextKey: buildContextKey(attempt.reviewId, o.correctionId, evidenceType),
      };
    });

  const completedAt = new Date().toISOString();

  // ── Step 13: Persist evaluation + outcomes + evidence ────────────────────
  let persistedEvaluation;
  try {
    const persistResult = await persistRewriteEvaluation(supabase, {
      evaluation: {
        userId: authenticatedUserId,
        missionId: attempt.missionId,
        originalSubmissionId: attempt.reviewId, // english_reviews.id
        rewriteSubmissionId,
        reviewId: attempt.reviewId,
        evaluationVersion,
        scores: finalScores,
        independenceAssessment: copyAssessment,
        summaryPtBR: modelOutput.summaryPtBR,
        correctionOutcomes,
        newIssues: modelOutput.newIssues,
        scoringVersion: CURRENT_SCORING_VERSION,
        schemaVersion: modelOutput.schemaVersion,
        promptVersion: 'v1',
        modelProvider: 'openai',
        modelName: 'gpt-4o',
      },
      evidenceCandidates,
    });

    persistedEvaluation = persistResult.evaluation;

    // Mark as completed
    await updateEvaluationStatus(supabase, persistedEvaluation.id, 'completed', completedAt);
    persistedEvaluation.status = 'completed';
    persistedEvaluation.completedAt = completedAt;

    logRewriteEvent({
      event: 'rewrite_evidence_candidates_created',
      rewriteSubmissionId,
      reviewId: attempt.reviewId,
      requestId: clientRequestId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logRewriteEvent({
      event: 'rewrite_evaluation_failed',
      rewriteSubmissionId,
      requestId: clientRequestId,
      errorMessage,
    });
    await updateRewriteAttemptStatus(supabase, rewriteSubmissionId, 'evaluation_failed');
    throw new Error(`Failed to persist evaluation: ${errorMessage}`);
  }

  // ── Step 14: Update rewrite status to 'evaluated' ─────────────────────────
  const updatedAttempt = await updateRewriteAttemptStatus(
    supabase,
    rewriteSubmissionId,
    'evaluated',
  );

  logRewriteEvent({
    event: 'rewrite_evaluation_completed',
    rewriteSubmissionId,
    reviewId: attempt.reviewId,
    missionId: attempt.missionId,
    requestId: clientRequestId,
    evaluationVersion,
    scoringVersion: CURRENT_SCORING_VERSION,
    independenceAssessment: copyAssessment,
    latencyMs: Date.now() - startMs,
  });

  // ── Step 15: Return public DTO ────────────────────────────────────────────
  return buildPublicRewriteDTO(updatedAttempt, originalText, correctedText, persistedEvaluation);
}
