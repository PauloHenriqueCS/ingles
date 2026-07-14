/**
 * SERVER-ONLY: CRUD for learner_vocabulary_mastery table.
 * Never import in React components or client-side bundles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  LearnerVocabularyMastery,
  VocabularyLearningState,
} from '../domain/vocabulary/vocabulary-types';

function rowToMastery(row: Record<string, unknown>): LearnerVocabularyMastery {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    vocabularyItemId: String(row.vocabulary_item_id),
    state: String(row.state) as VocabularyLearningState,
    totalExposures: Number(row.total_exposures ?? 0),
    totalOpportunities: Number(row.total_opportunities ?? 0),
    successfulRecalls: Number(row.successful_recalls ?? 0),
    successfulUses: Number(row.successful_uses ?? 0),
    independentUses: Number(row.independent_uses ?? 0),
    guidedUses: Number(row.guided_uses ?? 0),
    assistedUses: Number(row.assisted_uses ?? 0),
    errorCount: Number(row.error_count ?? 0),
    lapseCount: Number(row.lapse_count ?? 0),
    distinctContextCount: Number(row.distinct_context_count ?? 0),
    stability: Number(row.stability ?? 1.0),
    difficulty: Number(row.difficulty ?? 0.3),
    confidence: Number(row.confidence ?? 0),
    firstSeenAt: row.first_seen_at != null ? String(row.first_seen_at) : null,
    lastSeenAt: row.last_seen_at != null ? String(row.last_seen_at) : null,
    lastPracticedAt: row.last_practiced_at != null ? String(row.last_practiced_at) : null,
    lastSuccessAt: row.last_success_at != null ? String(row.last_success_at) : null,
    nextReviewAt: row.next_review_at != null ? String(row.next_review_at) : null,
    masteredAt: row.mastered_at != null ? String(row.mastered_at) : null,
    suspendedAt: row.suspended_at != null ? String(row.suspended_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getLearnerVocabularyMastery(
  supabase: SupabaseClient,
  userId: string,
  vocabularyItemId: string,
): Promise<LearnerVocabularyMastery | null> {
  const { data, error } = await supabase
    .from('learner_vocabulary_mastery')
    .select('*')
    .eq('user_id', userId)
    .eq('vocabulary_item_id', vocabularyItemId)
    .maybeSingle();

  if (error) throw new Error(`getLearnerVocabularyMastery: ${error.message}`);
  if (!data) return null;
  return rowToMastery(data as Record<string, unknown>);
}

export async function listDueVocabularyItems(
  supabase: SupabaseClient,
  userId: string,
  nowIso?: string,
): Promise<LearnerVocabularyMastery[]> {
  const now = nowIso ?? new Date().toISOString();

  const { data, error } = await supabase
    .from('learner_vocabulary_mastery')
    .select('*')
    .eq('user_id', userId)
    .lte('next_review_at', now)
    .not('state', 'in', '("new","suspended")')
    .order('next_review_at', { ascending: true });

  if (error) throw new Error(`listDueVocabularyItems: ${error.message}`);
  return (data ?? []).map(row => rowToMastery(row as Record<string, unknown>));
}

export async function upsertVocabularyMastery(
  supabase: SupabaseClient,
  mastery: Omit<LearnerVocabularyMastery, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<LearnerVocabularyMastery> {
  const now = new Date().toISOString();

  const payload = {
    user_id: mastery.userId,
    vocabulary_item_id: mastery.vocabularyItemId,
    state: mastery.state,
    total_exposures: mastery.totalExposures,
    total_opportunities: mastery.totalOpportunities,
    successful_recalls: mastery.successfulRecalls,
    successful_uses: mastery.successfulUses,
    independent_uses: mastery.independentUses,
    guided_uses: mastery.guidedUses,
    assisted_uses: mastery.assistedUses,
    error_count: mastery.errorCount,
    lapse_count: mastery.lapseCount,
    distinct_context_count: mastery.distinctContextCount,
    stability: mastery.stability,
    difficulty: mastery.difficulty,
    confidence: mastery.confidence,
    first_seen_at: mastery.firstSeenAt ?? null,
    last_seen_at: mastery.lastSeenAt ?? null,
    last_practiced_at: mastery.lastPracticedAt ?? null,
    last_success_at: mastery.lastSuccessAt ?? null,
    next_review_at: mastery.nextReviewAt ?? null,
    mastered_at: mastery.masteredAt ?? null,
    suspended_at: mastery.suspendedAt ?? null,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from('learner_vocabulary_mastery')
    .upsert(payload, { onConflict: 'user_id,vocabulary_item_id' })
    .select()
    .single();

  if (error) throw new Error(`upsertVocabularyMastery: ${error.message}`);
  return rowToMastery(data as Record<string, unknown>);
}

export async function updateVocabularyMasteryState(
  supabase: SupabaseClient,
  userId: string,
  vocabularyItemId: string,
  newState: VocabularyLearningState,
  nextReviewAt: string | null,
): Promise<void> {
  const updatePayload: Record<string, unknown> = {
    state: newState,
    next_review_at: nextReviewAt,
    updated_at: new Date().toISOString(),
  };

  if (newState === 'mastered') {
    updatePayload.mastered_at = new Date().toISOString();
  }
  if (newState === 'suspended') {
    updatePayload.suspended_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('learner_vocabulary_mastery')
    .update(updatePayload)
    .eq('user_id', userId)
    .eq('vocabulary_item_id', vocabularyItemId);

  if (error) throw new Error(`updateVocabularyMasteryState: ${error.message}`);
}
