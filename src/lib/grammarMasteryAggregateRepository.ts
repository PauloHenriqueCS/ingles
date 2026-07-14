/**
 * SERVER-ONLY: extended mastery aggregate operations.
 * Builds on existing learnerGrammarMasteryRepository.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MasteryAggregate } from '../domain/grammar-evidence/mastery-rules';
import { calculateGrammarMasteryConfidence } from '../domain/grammar-evidence/mastery-confidence';
import { getLearnerGrammarMastery } from './learnerGrammarMasteryRepository';

// Load all evidence for a topic and compute MasteryAggregate (for rebuild)
export async function computeMasteryAggregateFromEvidence(
  supabase: SupabaseClient,
  userId: string,
  grammarTopicId: string,
): Promise<MasteryAggregate> {
  const { data, error } = await supabase
    .from('learner_grammar_evidence')
    .select('*')
    .eq('user_id', userId)
    .eq('grammar_topic_id', grammarTopicId)
    .order('occurred_at', { ascending: true });

  if (error) throw new Error(`computeMasteryAggregateFromEvidence: ${error.message}`);

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  let totalOpportunities = 0;
  let successfulUses = 0;
  let partialUses = 0;
  let errorCount = 0;
  let independentUses = 0;
  let guidedUses = 0;
  let assistedUses = 0;
  let retentionSuccesses = 0;
  let retentionFailures = 0;
  let weightedSuccessScore = 0;
  let weightedErrorScore = 0;
  const contextFamilies = new Set<string>();
  let lastEvidenceAt: Date | null = null;

  for (const row of rows) {
    const evidenceType = String(row.evidence_type);
    const productionMode = String(row.production_mode);
    const evidenceWeight = Number(row.evidence_weight ?? 0);
    const contextFamily = String(row.context_family ?? 'unknown');
    const occurredAt = new Date(String(row.occurred_at));

    if (!lastEvidenceAt || occurredAt > lastEvidenceAt) {
      lastEvidenceAt = occurredAt;
    }

    contextFamilies.add(contextFamily);

    // Count opportunities (anything that represents an attempt or evidence)
    if (
      evidenceType === 'opportunity' ||
      evidenceType === 'successful_use' ||
      evidenceType === 'error' ||
      evidenceType === 'partial_success' ||
      evidenceType === 'retention_success' ||
      evidenceType === 'retention_failure'
    ) {
      totalOpportunities++;
    }

    if (evidenceType === 'successful_use' || evidenceType === 'retention_success') {
      successfulUses++;
    }

    if (evidenceType === 'partial_success') {
      partialUses++;
    }

    if (evidenceType === 'error' || evidenceType === 'retention_failure') {
      errorCount++;
    }

    if (
      productionMode === 'independent' &&
      (evidenceType === 'successful_use' || evidenceType === 'partial_success')
    ) {
      independentUses++;
    }
    if (
      productionMode === 'guided' &&
      (evidenceType === 'successful_use' || evidenceType === 'partial_success')
    ) {
      guidedUses++;
    }
    if (
      productionMode === 'assisted' &&
      (evidenceType === 'successful_use' || evidenceType === 'partial_success')
    ) {
      assistedUses++;
    }

    if (evidenceType === 'retention_success') {
      retentionSuccesses++;
    }
    if (evidenceType === 'retention_failure') {
      retentionFailures++;
    }

    if (evidenceWeight > 0) {
      weightedSuccessScore += evidenceWeight;
    } else if (evidenceWeight < 0) {
      weightedErrorScore += Math.abs(evidenceWeight);
    }
  }

  // Also read current mastery state from learner_grammar_mastery
  const currentMastery = await getLearnerGrammarMastery(supabase, userId, grammarTopicId);
  const currentState = currentMastery?.state ?? 'locked';

  const lastEvidenceAgeDays = lastEvidenceAt
    ? Math.floor((Date.now() - lastEvidenceAt.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const confidence = calculateGrammarMasteryConfidence({
    weightedSuccessScore,
    weightedErrorScore,
    independentUses,
    distinctContexts: contextFamilies.size,
    retentionSuccesses,
    retentionFailures,
    evidenceCount: rows.length,
    lastEvidenceAgeDays,
  });

  return {
    totalOpportunities,
    successfulUses,
    partialUses,
    errorCount,
    independentUses,
    guidedUses,
    assistedUses,
    retentionSuccesses,
    retentionFailures,
    distinctContextCount: contextFamilies.size,
    weightedSuccessScore,
    weightedErrorScore,
    confidence,
    currentState,
  };
}

// Update learner_grammar_mastery from computed aggregate
export async function persistMasteryAggregate(
  supabase: SupabaseClient,
  userId: string,
  grammarTopicId: string,
  agg: MasteryAggregate,
  updatedAt: string,
): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    total_opportunities: agg.totalOpportunities,
    successful_uses: agg.successfulUses,
    error_count: agg.errorCount,
    independent_uses: agg.independentUses,
    guided_uses: agg.guidedUses,
    assisted_uses: agg.assistedUses,
    distinct_context_count: agg.distinctContextCount,
    confidence: agg.confidence,
    updated_at: updatedAt,
    // Extended fields (added by migration 20260715020001)
    partial_uses: agg.partialUses,
    retention_successes: agg.retentionSuccesses,
    retention_failures: agg.retentionFailures,
    weighted_success_score: agg.weightedSuccessScore,
    weighted_error_score: agg.weightedErrorScore,
  };

  const { error } = await supabase
    .from('learner_grammar_mastery')
    .update(updatePayload)
    .eq('user_id', userId)
    .eq('grammar_topic_id', grammarTopicId);

  if (error) throw new Error(`persistMasteryAggregate: ${error.message}`);
}
