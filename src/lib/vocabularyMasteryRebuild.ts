/**
 * SERVER-ONLY: full rebuild of vocabulary mastery from evidence history.
 * Used for data corrections, backfills, and consistency checks.
 * Never import in React components or client-side bundles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VocabularyLearningState } from '../domain/vocabulary/vocabulary-types';
import type { LearnerVocabularyEvidence } from '../domain/vocabulary/vocabulary-types';
import { scheduleNextVocabularyReview } from '../domain/vocabulary/vocabulary-scheduling';
import { evaluateMasteryEligibility } from '../domain/vocabulary/vocabulary-mastery-rules';
import { VOCABULARY_SCHEDULING_VERSION } from '../domain/vocabulary/vocabulary-rules-version';
import { upsertVocabularyMastery, getLearnerVocabularyMastery } from './vocabularyMasteryRepository';
import { logVocabularyEvent } from './vocabularyObservability';

export interface VocabularyRebuildResult {
  vocabularyItemId: string;
  evidenceCount: number;
  previousState: string;
  newState: string;
  stateChanged: boolean;
}

export async function rebuildLearnerVocabularyMastery(
  supabase: SupabaseClient,
  userId: string,
  vocabularyItemId: string,
): Promise<VocabularyRebuildResult> {
  logVocabularyEvent({
    event: 'vocabulary_rebuild_started',
    userId,
    itemId: vocabularyItemId,
    schedulingVersion: VOCABULARY_SCHEDULING_VERSION,
  });

  // 1. Load all evidence for this user+item
  const { data: evidenceData, error: evidenceError } = await supabase
    .from('learner_vocabulary_evidence')
    .select('*')
    .eq('user_id', userId)
    .eq('vocabulary_item_id', vocabularyItemId)
    .order('occurred_at', { ascending: true });

  if (evidenceError) throw new Error(`rebuildLearnerVocabularyMastery (load evidence): ${evidenceError.message}`);

  const evidenceRows = (evidenceData ?? []) as Array<Record<string, unknown>>;
  const evidenceCount = evidenceRows.length;

  // Get current state for comparison
  const currentMastery = await getLearnerVocabularyMastery(supabase, userId, vocabularyItemId);
  const previousState = currentMastery?.state ?? 'new';

  // 2. Recompute all counters from scratch
  let totalExposures = 0;
  let totalOpportunities = 0;
  let successfulRecalls = 0;
  let successfulUses = 0;
  let independentUses = 0;
  let guidedUses = 0;
  let assistedUses = 0;
  let errorCount = 0;
  let lapseCount = 0;
  const contextFamilies = new Set<string>();
  let firstSeenAt: string | null = null;
  let lastSeenAt: string | null = null;
  let lastPracticedAt: string | null = null;
  let lastSuccessAt: string | null = null;
  let retentionSuccesses = 0;

  for (const row of evidenceRows) {
    const evidenceType = String(row.evidence_type);
    const productionMode = String(row.production_mode);
    const contextFamily = String(row.context_family ?? 'unknown');
    const occurredAt = String(row.occurred_at);

    contextFamilies.add(contextFamily);

    if (!firstSeenAt || occurredAt < firstSeenAt) firstSeenAt = occurredAt;
    if (!lastSeenAt || occurredAt > lastSeenAt) lastSeenAt = occurredAt;

    if (evidenceType === 'exposure') {
      totalExposures++;
    } else {
      totalOpportunities++;
      lastPracticedAt = occurredAt > (lastPracticedAt ?? '') ? occurredAt : lastPracticedAt;
    }

    if (evidenceType === 'recalled' || evidenceType === 'retention_success') {
      successfulRecalls++;
      lastSuccessAt = occurredAt > (lastSuccessAt ?? '') ? occurredAt : lastSuccessAt;
    }

    if (evidenceType === 'successful_use' || evidenceType === 'valid_synonym' || evidenceType === 'copied_use') {
      successfulUses++;
      lastSuccessAt = occurredAt > (lastSuccessAt ?? '') ? occurredAt : lastSuccessAt;
    }

    if (evidenceType === 'retention_success') {
      retentionSuccesses++;
    }

    if (
      (evidenceType === 'successful_use' || evidenceType === 'recalled' || evidenceType === 'valid_synonym') &&
      productionMode === 'independent'
    ) {
      independentUses++;
    }

    if (
      (evidenceType === 'successful_use' || evidenceType === 'recalled') &&
      productionMode === 'guided'
    ) {
      guidedUses++;
    }

    if (
      (evidenceType === 'successful_use' || evidenceType === 'recalled' || evidenceType === 'copied_use') &&
      productionMode === 'assisted'
    ) {
      assistedUses++;
    }

    if (
      evidenceType === 'incorrect_use' ||
      evidenceType === 'meaning_error' ||
      evidenceType === 'form_error' ||
      evidenceType === 'spelling_error'
    ) {
      errorCount++;
    }

    if (evidenceType === 'retention_failure') {
      lapseCount++;
    }
  }

  // 3. Recompute confidence
  const totalPositive = successfulRecalls + successfulUses + retentionSuccesses;
  const totalNegative = errorCount + lapseCount;
  const total = totalPositive + totalNegative;
  const confidence = total === 0 ? 0 : Math.min(1.0, (totalPositive / total) * (1 - 1 / (total + 1)));

  // 4. Re-run scheduling from evidence sequence (replay)
  let stability = 1.0;
  let difficulty = 0.3;
  let nextReviewAt: string | null = null;
  let currentState: VocabularyLearningState = 'new';
  let previousIntervalDays = 0;

  for (const row of evidenceRows) {
    const evidenceType = String(row.evidence_type) as LearnerVocabularyEvidence['evidenceType'];
    const productionMode = String(row.production_mode) as LearnerVocabularyEvidence['productionMode'];
    const weight = Number(row.weight ?? 0);
    const occurredAt = String(row.occurred_at);

    const result = scheduleNextVocabularyReview({
      currentState,
      stability,
      difficulty,
      lapseCount: lapseCount,
      previousIntervalDays,
      evidenceType,
      productionMode,
      evidenceWeight: weight,
      occurredAt,
      successfulRecalls,
      successfulUses,
    });

    currentState = result.newState;
    stability = result.newStability;
    difficulty = result.newDifficulty;
    nextReviewAt = result.nextReviewAt;
    previousIntervalDays = result.intervalDays ?? previousIntervalDays;
  }

  // 5. Evaluate mastery eligibility
  const masteryResult = evaluateMasteryEligibility({
    successfulRecalls,
    successfulUses,
    independentUses,
    distinctContextCount: contextFamilies.size,
    retentionSuccesses,
    lapseCount,
    recentLapseCount: lapseCount > 0 ? 1 : 0, // conservative estimate for rebuild
    confidence,
    currentState,
  });

  if (masteryResult.eligible && currentState === 'reviewing') {
    currentState = 'mastered';
    nextReviewAt = null;
  }

  // 6. Update mastery record
  await upsertVocabularyMastery(supabase, {
    userId,
    vocabularyItemId,
    state: currentState,
    totalExposures,
    totalOpportunities,
    successfulRecalls,
    successfulUses,
    independentUses,
    guidedUses,
    assistedUses,
    errorCount,
    lapseCount,
    distinctContextCount: contextFamilies.size,
    stability,
    difficulty,
    confidence,
    firstSeenAt,
    lastSeenAt,
    lastPracticedAt,
    lastSuccessAt,
    nextReviewAt,
    masteredAt: currentState === 'mastered' ? new Date().toISOString() : null,
    suspendedAt: currentState === 'suspended' ? new Date().toISOString() : null,
  });

  const stateChanged = previousState !== currentState;

  logVocabularyEvent({
    event: 'vocabulary_rebuild_completed',
    userId,
    itemId: vocabularyItemId,
    previousState,
    newState: currentState,
    schedulingVersion: VOCABULARY_SCHEDULING_VERSION,
  });

  // 7. Return result
  return {
    vocabularyItemId,
    evidenceCount,
    previousState,
    newState: currentState,
    stateChanged,
  };
}

export async function rebuildAllVocabularyForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<VocabularyRebuildResult[]> {
  // List all vocabulary_item_ids from learner_vocabulary_mastery
  const { data, error } = await supabase
    .from('learner_vocabulary_mastery')
    .select('vocabulary_item_id')
    .eq('user_id', userId);

  if (error) throw new Error(`rebuildAllVocabularyForUser: ${error.message}`);

  const itemIds = (data ?? []).map(row =>
    String((row as Record<string, unknown>).vocabulary_item_id),
  );

  const results: VocabularyRebuildResult[] = [];
  for (const vocabularyItemId of itemIds) {
    const result = await rebuildLearnerVocabularyMastery(supabase, userId, vocabularyItemId);
    results.push(result);
  }

  return results;
}
