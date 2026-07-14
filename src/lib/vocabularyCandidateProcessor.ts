/**
 * SERVER-ONLY: main entry point for vocabulary evidence pipeline.
 * Processes vocabulary evidence candidates into confirmed evidence and updates mastery.
 * Never import in React components or client-side bundles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  VocabularyEvidenceType,
  VocabularyProductionMode,
  VocabularyEvidenceSourceType,
} from '../domain/vocabulary/vocabulary-types';
import { normalizeVocabularyValue, inferVocabularyKind, isMultiwordExpression } from '../domain/vocabulary/vocabulary-normalization';
import { calculateVocabularyEvidenceWeight, isPositiveVocabularyEvidence } from '../domain/vocabulary/vocabulary-evidence-weighting';
import { scheduleNextVocabularyReview } from '../domain/vocabulary/vocabulary-scheduling';
import { VOCABULARY_EVIDENCE_RULES_VERSION, VOCABULARY_SCHEDULING_VERSION } from '../domain/vocabulary/vocabulary-rules-version';
import { buildVocabularyEvidenceIdempotencyKey } from './vocabularyIdempotency';
import { findOrCreateVocabularyItem } from './vocabularyItemRepository';
import { createVocabularyEvidence } from './vocabularyEvidenceRepository';
import { getLearnerVocabularyMastery, upsertVocabularyMastery } from './vocabularyMasteryRepository';
import { recordVocabularyHistory } from './vocabularyHistoryService';
import { logVocabularyEvent } from './vocabularyObservability';

export interface ProcessVocabularyEvidenceInput {
  userId: string;
  sourceType: string;
  sourceId: string;
  missionId?: string;
  reviewId?: string;
  rewriteSubmissionId?: string;
  contextFamily?: string;
  vocabularyItems: Array<{
    value: string;
    isPlanned?: boolean;
    plannedRole?: string;
    isFromCorrectedText?: boolean;  // came from AI correction → system_generated
    isFromSuggestion?: boolean;     // appeared in suggestions/support
    isFromRewrite?: boolean;        // user typed in rewrite
    productionMode?: string;
    evaluationStatus?: string;      // 'correct' | 'incorrect_*' | 'missing' | etc.
    isSynonym?: boolean;
    synonymFor?: string;            // normalized canonical value
    contextKey?: string;
  }>;
  copySignalAssessment?: string;    // from rewrite evaluation
  rulesVersion?: string;
}

export interface ProcessVocabularyEvidenceResult {
  evidenceCreated: number;
  duplicates: number;
  itemsResolved: string[];    // vocabulary_item_ids touched
}

function resolveEvidenceType(item: ProcessVocabularyEvidenceInput['vocabularyItems'][0]): VocabularyEvidenceType {
  const { evaluationStatus, isFromCorrectedText, isFromSuggestion, isFromRewrite, isSynonym, productionMode } = item;

  // system_generated (from AI correction) → exposure
  if (isFromCorrectedText) return 'exposure';

  // From suggestion/support but not produced → exposure
  if (isFromSuggestion && !isFromRewrite) return 'exposure';

  // Synonym used
  if (isSynonym) return 'valid_synonym';

  if (!evaluationStatus) return 'exposure';

  switch (evaluationStatus) {
    case 'correct': {
      const mode = (productionMode ?? 'unknown').toLowerCase();
      if (mode === 'assisted' || mode === 'system_generated') return 'copied_use';
      if (isFromRewrite) return 'successful_use';
      return 'recalled';
    }
    case 'incorrect_spelling':
      return 'spelling_error';
    case 'incorrect_usage':
    case 'incorrect':
      return 'incorrect_use';
    case 'missing':
      return 'missed_required_item';
    case 'forced_usage':
      return 'incorrect_use';
    case 'partial':
      return 'partial_use';
    default:
      return 'exposure';
  }
}

function resolveProductionMode(item: ProcessVocabularyEvidenceInput['vocabularyItems'][0], copySignalAssessment?: string): VocabularyProductionMode {
  // isFromCorrectedText always system_generated
  if (item.isFromCorrectedText) return 'system_generated';

  if (item.productionMode) {
    const m = item.productionMode.toLowerCase();
    if (m === 'independent') return 'independent';
    if (m === 'guided') return 'guided';
    if (m === 'assisted') return 'assisted';
    if (m === 'system_generated') return 'system_generated';
  }

  // Infer from copy signal
  if (copySignalAssessment) {
    switch (copySignalAssessment) {
      case 'independent':
      case 'likely_independent':
        return 'independent';
      case 'uncertain':
        return 'guided';
      case 'likely_copied':
      case 'copied':
        return 'assisted';
    }
  }

  return 'unknown';
}

function evidenceTypeToOutcome(evidenceType: VocabularyEvidenceType): 'success' | 'partial' | 'failure' | 'neutral' {
  switch (evidenceType) {
    case 'successful_use':
    case 'recalled':
    case 'valid_synonym':
    case 'copied_use':
    case 'retention_success':
      return 'success';
    case 'partial_use':
      return 'partial';
    case 'incorrect_use':
    case 'meaning_error':
    case 'form_error':
    case 'spelling_error':
    case 'missed_required_item':
    case 'retention_failure':
      return 'failure';
    default:
      return 'neutral';
  }
}

function isMeaningfulStateChange(previousState: string, newState: string): boolean {
  return previousState !== newState;
}

export async function processVocabularyEvidenceCandidates(
  supabase: SupabaseClient,
  input: ProcessVocabularyEvidenceInput,
): Promise<ProcessVocabularyEvidenceResult> {
  const rulesVersion = input.rulesVersion ?? VOCABULARY_EVIDENCE_RULES_VERSION;
  const startMs = Date.now();
  const contextFamily = input.contextFamily ?? 'unknown';

  logVocabularyEvent({
    event: 'vocabulary_candidate_processing_started',
    userId: input.userId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });

  let evidenceCreated = 0;
  let duplicates = 0;
  const itemsResolvedSet = new Set<string>();

  for (const vocabItem of input.vocabularyItems) {
    try {
      const normalizedValue = normalizeVocabularyValue(vocabItem.value);
      if (!normalizedValue) continue;

      // 1. Determine productionMode
      const productionMode = resolveProductionMode(vocabItem, input.copySignalAssessment);

      // 2. Resolve item: findOrCreateVocabularyItem
      const kind = inferVocabularyKind(vocabItem.value);
      const isMultiword = isMultiwordExpression(vocabItem.value);

      const vocabularyItem = await findOrCreateVocabularyItem(supabase, {
        canonicalValue: vocabItem.value.trim(),
        normalizedValue,
        kind,
        isMultiword,
      });

      logVocabularyEvent({
        event: 'vocabulary_item_resolved',
        userId: input.userId,
        itemId: vocabularyItem.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      });

      // 3. Determine evidenceType
      const evidenceType = resolveEvidenceType(vocabItem);

      // 4. Calculate evidenceWeight
      const evidenceWeight = calculateVocabularyEvidenceWeight({
        evidenceType,
        productionMode,
        weightsVersion: rulesVersion,
      });

      // 5. Build idempotencyKey
      const occurrenceKey = vocabItem.contextKey ?? `${contextFamily}:${vocabItem.value}`;
      const idempotencyKey = buildVocabularyEvidenceIdempotencyKey({
        sourceType: input.sourceType as VocabularyEvidenceSourceType,
        sourceId: input.sourceId,
        vocabularyItemId: vocabularyItem.id,
        evidenceType,
        occurrenceKey,
      });

      const outcome = evidenceTypeToOutcome(evidenceType);
      const occurredAt = new Date().toISOString();

      // 6. createVocabularyEvidence (idempotent)
      const evidence = await createVocabularyEvidence(supabase, {
        userId: input.userId,
        vocabularyItemId: vocabularyItem.id,
        sourceType: input.sourceType as VocabularyEvidenceSourceType,
        sourceId: input.sourceId,
        missionId: input.missionId,
        reviewId: input.reviewId,
        rewriteSubmissionId: input.rewriteSubmissionId,
        evidenceType,
        productionMode,
        outcome,
        contextKey: occurrenceKey,
        contextFamily,
        confidence: 0.8,
        weight: evidenceWeight,
        occurredAt,
        idempotencyKey,
        rulesVersion,
      });

      // Detect duplicate: compare createdAt to now
      const createdRecently = Date.now() - new Date(evidence.createdAt).getTime() < 3000;

      if (!createdRecently) {
        // Duplicate
        duplicates++;
        logVocabularyEvent({
          event: 'vocabulary_evidence_duplicate_ignored',
          userId: input.userId,
          itemId: vocabularyItem.id,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          evidenceType,
        });
        continue;
      }

      // 7. Evidence was created — update mastery aggregates + schedule
      evidenceCreated++;
      itemsResolvedSet.add(vocabularyItem.id);

      logVocabularyEvent({
        event: 'vocabulary_evidence_created',
        userId: input.userId,
        itemId: vocabularyItem.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        evidenceType,
        productionMode,
      });

      // Load current mastery (or create defaults)
      const currentMastery = await getLearnerVocabularyMastery(
        supabase,
        input.userId,
        vocabularyItem.id,
      );

      const prevState = currentMastery?.state ?? 'new';
      const prevStability = currentMastery?.stability ?? 1.0;
      const prevNextReviewAt = currentMastery?.nextReviewAt ?? null;

      // Compute new scheduling
      const schedulingResult = scheduleNextVocabularyReview({
        currentState: prevState,
        stability: prevStability,
        difficulty: currentMastery?.difficulty ?? 0.3,
        lapseCount: currentMastery?.lapseCount ?? 0,
        previousIntervalDays: 0,
        evidenceType,
        productionMode,
        evidenceWeight,
        occurredAt,
        successfulRecalls: (currentMastery?.successfulRecalls ?? 0) + (evidenceType === 'recalled' ? 1 : 0),
        successfulUses: (currentMastery?.successfulUses ?? 0) + (evidenceType === 'successful_use' ? 1 : 0),
      });

      // Update counters
      const newTotalExposures = (currentMastery?.totalExposures ?? 0) + (evidenceType === 'exposure' ? 1 : 0);
      const newTotalOpportunities = (currentMastery?.totalOpportunities ?? 0) + (evidenceType !== 'exposure' ? 1 : 0);
      const newSuccessfulRecalls = (currentMastery?.successfulRecalls ?? 0) + (evidenceType === 'recalled' ? 1 : 0);
      const newSuccessfulUses = (currentMastery?.successfulUses ?? 0) +
        (evidenceType === 'successful_use' || evidenceType === 'valid_synonym' ? 1 : 0);
      const newIndependentUses = (currentMastery?.independentUses ?? 0) +
        ((evidenceType === 'successful_use' || evidenceType === 'recalled') && productionMode === 'independent' ? 1 : 0);
      const newGuidedUses = (currentMastery?.guidedUses ?? 0) +
        ((evidenceType === 'successful_use' || evidenceType === 'recalled') && productionMode === 'guided' ? 1 : 0);
      const newAssistedUses = (currentMastery?.assistedUses ?? 0) +
        ((evidenceType === 'copied_use') && productionMode === 'assisted' ? 1 : 0);
      const newErrorCount = (currentMastery?.errorCount ?? 0) +
        (evidenceType === 'incorrect_use' || evidenceType === 'meaning_error' ||
         evidenceType === 'form_error' || evidenceType === 'spelling_error' ? 1 : 0);
      const newLapseCount = (currentMastery?.lapseCount ?? 0) + schedulingResult.lapseIncrement;

      const now = new Date().toISOString();

      // Distinct contexts
      const newDistinctContextCount = await (async () => {
        try {
          const { data } = await supabase
            .from('learner_vocabulary_evidence')
            .select('context_family')
            .eq('user_id', input.userId)
            .eq('vocabulary_item_id', vocabularyItem.id);
          const families = new Set((data ?? []).map((r: Record<string, unknown>) => String(r.context_family)));
          return families.size;
        } catch {
          return currentMastery?.distinctContextCount ?? 1;
        }
      })();

      // Confidence: simple ratio
      const totalPos = newSuccessfulRecalls + newSuccessfulUses;
      const totalNeg = newErrorCount + newLapseCount;
      const totalAll = totalPos + totalNeg;
      const newConfidence = totalAll === 0 ? 0 : Math.min(1.0, (totalPos / totalAll) * (1 - 1 / (totalAll + 1)));

      await upsertVocabularyMastery(supabase, {
        userId: input.userId,
        vocabularyItemId: vocabularyItem.id,
        state: schedulingResult.newState,
        totalExposures: newTotalExposures,
        totalOpportunities: newTotalOpportunities,
        successfulRecalls: newSuccessfulRecalls,
        successfulUses: newSuccessfulUses,
        independentUses: newIndependentUses,
        guidedUses: newGuidedUses,
        assistedUses: newAssistedUses,
        errorCount: newErrorCount,
        lapseCount: newLapseCount,
        distinctContextCount: newDistinctContextCount,
        stability: schedulingResult.newStability,
        difficulty: schedulingResult.newDifficulty,
        confidence: newConfidence,
        firstSeenAt: currentMastery?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastPracticedAt: evidenceType !== 'exposure' ? now : (currentMastery?.lastPracticedAt ?? null),
        lastSuccessAt: isPositiveVocabularyEvidence(evidenceType) ? now : (currentMastery?.lastSuccessAt ?? null),
        nextReviewAt: schedulingResult.nextReviewAt,
        masteredAt: schedulingResult.newState === 'mastered'
          ? (currentMastery?.masteredAt ?? now)
          : null,
        suspendedAt: currentMastery?.suspendedAt ?? null,
      });

      logVocabularyEvent({
        event: 'vocabulary_schedule_updated',
        userId: input.userId,
        itemId: vocabularyItem.id,
        previousState: prevState,
        newState: schedulingResult.newState,
        nextReviewAt: schedulingResult.nextReviewAt ?? undefined,
        schedulingVersion: VOCABULARY_SCHEDULING_VERSION,
      });

      // 8. If meaningful state change: record history
      if (isMeaningfulStateChange(prevState, schedulingResult.newState) || schedulingResult.lapseIncrement > 0) {
        try {
          await recordVocabularyHistory(supabase, {
            userId: input.userId,
            vocabularyItemId: vocabularyItem.id,
            previousState: prevState,
            newState: schedulingResult.newState,
            previousNextReviewAt: prevNextReviewAt,
            newNextReviewAt: schedulingResult.nextReviewAt,
            previousStability: prevStability,
            newStability: schedulingResult.newStability,
            reasonCode: schedulingResult.reasonCode,
            evidenceIds: [evidence.id],
            schedulingVersion: VOCABULARY_SCHEDULING_VERSION,
          });
        } catch (histErr) {
          // History failure is non-fatal
          logVocabularyEvent({
            event: 'vocabulary_processing_failed',
            userId: input.userId,
            itemId: vocabularyItem.id,
            errorMessage: histErr instanceof Error ? histErr.message : String(histErr),
          });
        }
      }

      // 9. Log state events
      if (schedulingResult.newState === 'mastered') {
        logVocabularyEvent({
          event: 'vocabulary_item_mastered',
          userId: input.userId,
          itemId: vocabularyItem.id,
          schedulingVersion: VOCABULARY_SCHEDULING_VERSION,
        });
      }

      if (schedulingResult.lapseIncrement > 0) {
        logVocabularyEvent({
          event: 'vocabulary_lapse_detected',
          userId: input.userId,
          itemId: vocabularyItem.id,
          previousState: prevState,
          newState: schedulingResult.newState,
        });
      }
    } catch (err) {
      // Log and continue to next item (partial failure is non-fatal)
      logVocabularyEvent({
        event: 'vocabulary_processing_failed',
        userId: input.userId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        errorMessage: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startMs,
      });
    }
  }

  return {
    evidenceCreated,
    duplicates,
    itemsResolved: Array.from(itemsResolvedSet),
  };
}
