/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { LearnerGrammarMastery, GrammarMasteryState } from '../domain/learner/grammar-mastery-types';

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToMastery(row: Record<string, unknown>): LearnerGrammarMastery {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    grammarTopicId: String(row.grammar_topic_id),
    catalogVersion: Number(row.catalog_version ?? 1),
    state: String(row.mastery_state) as GrammarMasteryState,
    totalOpportunities: Number(row.total_opportunities ?? 0),
    successfulUses: Number(row.successful_uses ?? 0),
    errorCount: Number(row.error_count ?? 0),
    independentUses: Number(row.independent_uses ?? 0),
    guidedUses: Number(row.guided_uses ?? 0),
    assistedUses: Number(row.assisted_uses ?? 0),
    distinctContextCount: Number(row.distinct_context_count ?? 0),
    confidence: Number(row.confidence ?? 0),
    firstIntroducedAt: row.first_introduced_at != null ? String(row.first_introduced_at) : null,
    lastPracticedAt: row.last_practiced_at != null ? String(row.last_practiced_at) : null,
    lastSuccessfulUseAt: row.last_successful_use_at != null ? String(row.last_successful_use_at) : null,
    masteredAt: row.mastered_at != null ? String(row.mastered_at) : null,
    maintenanceDueAt: row.maintenance_due_at != null ? String(row.maintenance_due_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getLearnerGrammarMastery(
  supabase: SupabaseClient,
  userId: string,
  topicId: string,
): Promise<LearnerGrammarMastery | null> {
  const { data, error } = await supabase
    .from('learner_grammar_mastery')
    .select('*')
    .eq('user_id', userId)
    .eq('grammar_topic_id', topicId)
    .maybeSingle();

  if (error) throw new Error(`getLearnerGrammarMastery: ${error.message}`);
  if (!data) return null;
  return rowToMastery(data as Record<string, unknown>);
}

export async function listLearnerGrammarMastery(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerGrammarMastery[]> {
  const { data, error } = await supabase
    .from('learner_grammar_mastery')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(`listLearnerGrammarMastery: ${error.message}`);
  return (data ?? []).map(row => rowToMastery(row as Record<string, unknown>));
}

export async function upsertLearnerGrammarMastery(
  supabase: SupabaseClient,
  mastery: Omit<LearnerGrammarMastery, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<LearnerGrammarMastery> {
  const payload = {
    user_id: mastery.userId,
    grammar_topic_id: mastery.grammarTopicId,
    catalog_version: mastery.catalogVersion,
    mastery_state: mastery.state,
    total_opportunities: mastery.totalOpportunities,
    successful_uses: mastery.successfulUses,
    error_count: mastery.errorCount,
    independent_uses: mastery.independentUses,
    guided_uses: mastery.guidedUses,
    assisted_uses: mastery.assistedUses,
    distinct_context_count: mastery.distinctContextCount,
    confidence: mastery.confidence,
    first_introduced_at: mastery.firstIntroducedAt,
    last_practiced_at: mastery.lastPracticedAt,
    last_successful_use_at: mastery.lastSuccessfulUseAt,
    mastered_at: mastery.masteredAt,
    maintenance_due_at: mastery.maintenanceDueAt,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('learner_grammar_mastery')
    .upsert(payload, { onConflict: 'user_id,grammar_topic_id' })
    .select()
    .single();

  if (error) throw new Error(`upsertLearnerGrammarMastery: ${error.message}`);
  return rowToMastery(data as Record<string, unknown>);
}
