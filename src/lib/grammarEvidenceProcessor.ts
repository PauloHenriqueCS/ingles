/**
 * SERVER-ONLY: main entry point for grammar evidence pipeline.
 * Processes evidence candidates into confirmed evidence and updates mastery.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  GrammarEvidenceType,
  GrammarProductionMode,
  GrammarEvidenceOutcome,
  GrammarTopicRole,
} from '../domain/grammar-evidence/evidence-types';
import { evaluateGrammarOpportunity } from '../domain/grammar-evidence/opportunity-evaluation';
import { resolveProductionMode, productionModeToSupportLevel } from '../domain/grammar-evidence/production-mode';
import { calculateEvidenceWeight } from '../domain/grammar-evidence/evidence-weighting';
import { extractContextFamily, buildContextKey } from '../domain/grammar-evidence/context-diversity';
import { GRAMMAR_EVIDENCE_RULES_VERSION } from '../domain/grammar-evidence/rules-version';
import { CURRENT_CATALOG_VERSION } from '../domain/learner/constants';
import { buildEvidenceIdempotencyKey } from './grammarEvidenceIdempotency';
import { createGrammarEvidence } from './grammarEvidenceRepository';
import {
  loadUnprocessedRewriteCandidates,
  loadUnprocessedReviewCandidates,
  markCandidateProcessed,
} from './grammarEvidenceCandidateRepository';
import { updateMasteryAfterEvidence } from './grammarMasteryAggregator';
import { logGrammarEvidenceEvent } from './grammarEvidenceObservability';

export interface ProcessGrammarEvidenceInput {
  userId: string;
  sourceType: 'rewrite_evaluation' | 'original_review';
  sourceId: string;
  missionId?: string;
  submissionId?: string;
  reviewId?: string;
  rewriteSubmissionId?: string;
  effectiveLevel?: string;
  contextFamily?: string;
  missionRequiredTopic?: string;
  supportUsageSnapshot?: {
    correctedTextVisible?: boolean;
    correctionsExpanded?: boolean;
    supportSentencesAvailable?: boolean;
    helpUsed?: boolean;
    copySignalAssessment?: string;
  };
  rulesVersion?: string;
}

export interface ProcessGrammarEvidenceResult {
  evidenceCreated: number;
  evidenceDuplicates: number;
  topicsUpdated: string[];
  transitionsTriggered: Array<{ topicId: string; from: string; to: string }>;
}

// Map rewrite evidence type to grammar evidence type
function mapRewriteEvidenceType(rewriteType: string): GrammarEvidenceType {
  switch (rewriteType) {
    case 'error_corrected_independently':          return 'successful_use';
    case 'error_corrected_with_possible_copy':     return 'partial_success';
    case 'valid_reformulation':                    return 'successful_use';
    case 'error_persisted':                        return 'error';
    case 'new_error_introduced':                   return 'error';
    case 'no_independent_evidence':                return 'no_opportunity';
    default:                                       return 'opportunity';
  }
}

// Map independence assessment to production mode
function mapIndependenceToProductionMode(assessment: string): GrammarProductionMode {
  switch (assessment) {
    case 'independent':        return 'independent';
    case 'likely_independent': return 'independent';
    case 'uncertain':          return 'guided';
    case 'likely_copied':      return 'assisted';
    case 'copied':             return 'assisted';
    default:                   return 'unknown';
  }
}

function evidenceTypeToOutcome(evidenceType: GrammarEvidenceType): GrammarEvidenceOutcome {
  switch (evidenceType) {
    case 'successful_use':
    case 'retention_success':
      return 'success';
    case 'partial_success':
    case 'attempt_above_level':
      return 'partial';
    case 'error':
    case 'retention_failure':
      return 'failure';
    default:
      return 'neutral';
  }
}

export async function processGrammarEvidenceCandidates(
  supabase: SupabaseClient,
  input: ProcessGrammarEvidenceInput,
): Promise<ProcessGrammarEvidenceResult> {
  const rulesVersion = input.rulesVersion ?? GRAMMAR_EVIDENCE_RULES_VERSION;
  const startMs = Date.now();

  // 1. Log processing started
  logGrammarEvidenceEvent({
    event: 'grammar_evidence_processing_started',
    userId: input.userId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    rulesVersion,
  });

  // 2. Load unprocessed candidates
  let candidates;
  try {
    candidates = input.sourceType === 'rewrite_evaluation'
      ? await loadUnprocessedRewriteCandidates(supabase, input.sourceId)
      : await loadUnprocessedReviewCandidates(supabase, input.sourceId);
  } catch (err) {
    logGrammarEvidenceEvent({
      event: 'grammar_evidence_processing_failed',
      userId: input.userId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      errorMessage: err instanceof Error ? err.message : String(err),
      rulesVersion,
    });
    throw err;
  }

  logGrammarEvidenceEvent({
    event: 'grammar_evidence_candidate_loaded',
    userId: input.userId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    rulesVersion,
  });

  let evidenceCreated = 0;
  let evidenceDuplicates = 0;
  const topicsUpdatedSet = new Set<string>();
  const transitionsTriggered: Array<{ topicId: string; from: string; to: string }> = [];

  // 3. For each candidate with grammarTopicId
  for (const candidate of candidates) {
    try {
      if (!candidate.grammarTopicId) {
        await markCandidateProcessed(supabase, candidate.id, candidate.sourceType);
        continue;
      }

      const grammarTopicId = candidate.grammarTopicId;

      // Map evidence type
      const evidenceType = mapRewriteEvidenceType(candidate.evidenceType);

      // c. Evaluate opportunity
      const contextFamily = input.contextFamily
        ? extractContextFamily(input.contextFamily)
        : extractContextFamily(candidate.contextKey);

      const oppEval = evaluateGrammarOpportunity({
        topicId: grammarTopicId,
        topicRole: 'unplanned',
        submissionTextLength: 100, // conservative default; real value injected if available
        plannedTopic: false,
        topicExpectedInContext: true,
        estimatedOccurrencesInText: evidenceType === 'no_opportunity' ? 0 : 1,
        missionRequiredStructure: input.missionRequiredTopic === grammarTopicId,
        levelMatchesTopicMinimum: true,
      });

      logGrammarEvidenceEvent({
        event: 'grammar_opportunity_evaluated',
        userId: input.userId,
        topicId: grammarTopicId,
        sourceId: input.sourceId,
        rulesVersion,
      });

      // d. Resolve productionMode
      const support = input.supportUsageSnapshot ?? {};
      const productionMode = resolveProductionMode({
        submissionType: input.sourceType === 'rewrite_evaluation' ? 'rewrite_v2' : 'original',
        sourceType: input.sourceType,
        copySignalAssessment: support.copySignalAssessment as
          | 'independent' | 'likely_independent' | 'uncertain' | 'likely_copied' | 'copied'
          | undefined,
        correctedTextVisible: support.correctedTextVisible,
        correctionsExpanded: support.correctionsExpanded,
        supportSentencesAvailable: support.supportSentencesAvailable,
        helpUsed: support.helpUsed,
        plannedTopic: false,
        missionHasDirectInstruction: false,
      }) || mapIndependenceToProductionMode(candidate.independenceAssessment);

      logGrammarEvidenceEvent({
        event: 'grammar_production_mode_resolved',
        userId: input.userId,
        topicId: grammarTopicId,
        productionMode,
        rulesVersion,
      });

      // e. Calculate evidenceWeight
      const topicRole: GrammarTopicRole = 'unplanned';
      const evidenceWeight = calculateEvidenceWeight({
        evidenceType,
        productionMode,
        topicRole,
        weightsVersion: rulesVersion,
      });

      const outcome = evidenceTypeToOutcome(evidenceType);
      const supportLevel = productionModeToSupportLevel(productionMode);
      const contextKey = buildContextKey({
        contextFamily,
        missionId: input.missionId,
        topicId: grammarTopicId,
      });

      // f. Build idempotency key
      const idempotencyKey = buildEvidenceIdempotencyKey({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        grammarTopicId,
        evidenceType,
        contextKey: candidate.contextKey || contextKey,
      });

      // g. createGrammarEvidence() — ON CONFLICT idempotency_key: skip (duplicate)
      const evidence = await createGrammarEvidence(supabase, {
        userId: input.userId,
        grammarTopicId,
        catalogVersion: CURRENT_CATALOG_VERSION,
        skill: 'writing',
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        missionId: input.missionId,
        submissionId: input.submissionId,
        reviewId: input.reviewId ?? candidate.reviewId,
        rewriteSubmissionId: input.rewriteSubmissionId,
        correctionId: candidate.correctionId,
        evidenceType,
        productionMode,
        outcome,
        opportunityWeight: oppEval.opportunityWeight,
        evidenceWeight,
        confidence: candidate.confidence,
        plannedTopic: false,
        topicRole,
        contextKey: candidate.contextKey || contextKey,
        contextFamily: String(contextFamily),
        supportLevel,
        helpUsed: support.helpUsed ?? false,
        occurredAt: candidate.createdAt,
        idempotencyKey,
        rulesVersion,
      });

      // createGrammarEvidence returns the existing row on conflict;
      // idempotency is handled by the unique constraint on idempotency_key.
      const createdRecently = Date.now() - new Date(evidence.createdAt).getTime() < 2000;

      if (!createdRecently) {
        // Was a duplicate
        evidenceDuplicates++;
        logGrammarEvidenceEvent({
          event: 'grammar_evidence_duplicate_ignored',
          userId: input.userId,
          topicId: grammarTopicId,
          sourceId: input.sourceId,
          rulesVersion,
        });
      } else {
        // h. If created (not duplicate): updateMasteryAfterEvidence()
        evidenceCreated++;
        topicsUpdatedSet.add(grammarTopicId);

        logGrammarEvidenceEvent({
          event: 'grammar_evidence_created',
          userId: input.userId,
          topicId: grammarTopicId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          evidenceType,
          productionMode,
          evidenceWeight,
          rulesVersion,
        });

        await updateMasteryAfterEvidence(supabase, input.userId, grammarTopicId, evidence);
      }

      // i. markCandidateProcessed()
      await markCandidateProcessed(supabase, candidate.id, candidate.sourceType);
    } catch (err) {
      // Log and continue to next candidate (partial failure is non-fatal)
      logGrammarEvidenceEvent({
        event: 'grammar_evidence_processing_failed',
        userId: input.userId,
        topicId: candidate.grammarTopicId,
        sourceId: input.sourceId,
        errorMessage: err instanceof Error ? err.message : String(err),
        rulesVersion,
        latencyMs: Date.now() - startMs,
      });
    }
  }

  return {
    evidenceCreated,
    evidenceDuplicates,
    topicsUpdated: Array.from(topicsUpdatedSet),
    transitionsTriggered,
  };
}
