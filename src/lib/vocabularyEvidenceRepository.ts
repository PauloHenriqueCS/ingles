/**
 * SERVER-ONLY: CRUD for learner_vocabulary_evidence table.
 * Never import in React components or client-side bundles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  LearnerVocabularyEvidence,
  VocabularyEvidenceSourceType,
  VocabularyEvidenceType,
  VocabularyProductionMode,
  PlannedVocabularyRole,
} from '../domain/vocabulary/vocabulary-types';

function rowToEvidence(row: Record<string, unknown>): LearnerVocabularyEvidence {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    vocabularyItemId: String(row.vocabulary_item_id),
    sourceType: String(row.source_type) as VocabularyEvidenceSourceType,
    sourceId: String(row.source_id),
    missionId: row.mission_id != null ? String(row.mission_id) : undefined,
    submissionId: row.submission_id != null ? String(row.submission_id) : undefined,
    reviewId: row.review_id != null ? String(row.review_id) : undefined,
    rewriteSubmissionId: row.rewrite_submission_id != null ? String(row.rewrite_submission_id) : undefined,
    evidenceType: String(row.evidence_type) as VocabularyEvidenceType,
    productionMode: String(row.production_mode) as VocabularyProductionMode,
    outcome: String(row.outcome) as 'success' | 'partial' | 'failure' | 'neutral',
    plannedRole: row.planned_role != null ? String(row.planned_role) as PlannedVocabularyRole : undefined,
    contextKey: String(row.context_key),
    contextFamily: String(row.context_family ?? 'unknown'),
    confidence: Number(row.confidence ?? 0.5),
    weight: Number(row.weight ?? 0),
    occurredAt: String(row.occurred_at),
    idempotencyKey: String(row.idempotency_key),
    rulesVersion: String(row.rules_version ?? 'v1'),
    metadataJson: row.metadata_json != null
      ? (row.metadata_json as Record<string, unknown>)
      : undefined,
    createdAt: String(row.created_at),
  };
}

export async function createVocabularyEvidence(
  supabase: SupabaseClient,
  input: Omit<LearnerVocabularyEvidence, 'id' | 'createdAt'>,
): Promise<LearnerVocabularyEvidence> {
  const payload = {
    user_id: input.userId,
    vocabulary_item_id: input.vocabularyItemId,
    source_type: input.sourceType,
    source_id: input.sourceId,
    mission_id: input.missionId ?? null,
    submission_id: input.submissionId ?? null,
    review_id: input.reviewId ?? null,
    rewrite_submission_id: input.rewriteSubmissionId ?? null,
    evidence_type: input.evidenceType,
    production_mode: input.productionMode,
    outcome: input.outcome,
    planned_role: input.plannedRole ?? null,
    context_key: input.contextKey,
    context_family: input.contextFamily,
    confidence: input.confidence,
    weight: input.weight,
    occurred_at: input.occurredAt,
    idempotency_key: input.idempotencyKey,
    rules_version: input.rulesVersion,
    metadata_json: input.metadataJson ?? null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('learner_vocabulary_evidence')
    .insert(payload)
    .select()
    .maybeSingle();

  if (insertError) {
    // ON CONFLICT (idempotency_key) — return existing
    if (
      insertError.code === '23505' ||
      insertError.message.includes('duplicate') ||
      insertError.message.includes('unique')
    ) {
      const { data: existing, error: fetchError } = await supabase
        .from('learner_vocabulary_evidence')
        .select('*')
        .eq('idempotency_key', input.idempotencyKey)
        .single();
      if (fetchError) throw new Error(`createVocabularyEvidence (fetch existing): ${fetchError.message}`);
      return rowToEvidence(existing as Record<string, unknown>);
    }
    throw new Error(`createVocabularyEvidence: ${insertError.message}`);
  }

  if (!inserted) {
    // Row silently ignored due to conflict
    const { data: existing, error: fetchError } = await supabase
      .from('learner_vocabulary_evidence')
      .select('*')
      .eq('idempotency_key', input.idempotencyKey)
      .single();
    if (fetchError) throw new Error(`createVocabularyEvidence (fetch after null): ${fetchError.message}`);
    return rowToEvidence(existing as Record<string, unknown>);
  }

  return rowToEvidence(inserted as Record<string, unknown>);
}

export async function getVocabularyEvidenceForItem(
  supabase: SupabaseClient,
  userId: string,
  vocabularyItemId: string,
): Promise<LearnerVocabularyEvidence[]> {
  const { data, error } = await supabase
    .from('learner_vocabulary_evidence')
    .select('*')
    .eq('user_id', userId)
    .eq('vocabulary_item_id', vocabularyItemId)
    .order('occurred_at', { ascending: false });

  if (error) throw new Error(`getVocabularyEvidenceForItem: ${error.message}`);
  return (data ?? []).map(row => rowToEvidence(row as Record<string, unknown>));
}

export async function getVocabularyEvidenceBySource(
  supabase: SupabaseClient,
  sourceType: string,
  sourceId: string,
): Promise<LearnerVocabularyEvidence[]> {
  const { data, error } = await supabase
    .from('learner_vocabulary_evidence')
    .select('*')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .order('occurred_at', { ascending: false });

  if (error) throw new Error(`getVocabularyEvidenceBySource: ${error.message}`);
  return (data ?? []).map(row => rowToEvidence(row as Record<string, unknown>));
}

export async function countDistinctContextsForItem(
  supabase: SupabaseClient,
  userId: string,
  vocabularyItemId: string,
): Promise<number> {
  // Supabase doesn't support COUNT(DISTINCT) directly; fetch all and count in JS
  const { data, error } = await supabase
    .from('learner_vocabulary_evidence')
    .select('context_family')
    .eq('user_id', userId)
    .eq('vocabulary_item_id', vocabularyItemId);

  if (error) throw new Error(`countDistinctContextsForItem: ${error.message}`);
  const families = new Set((data ?? []).map(row => String((row as Record<string, unknown>).context_family)));
  return families.size;
}
