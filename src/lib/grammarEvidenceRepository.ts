/**
 * SERVER-ONLY: CRUD for learner_grammar_evidence table.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  LearnerGrammarEvidence,
  GrammarEvidenceSourceType,
  GrammarEvidenceType,
  GrammarProductionMode,
  GrammarEvidenceOutcome,
  GrammarTopicRole,
} from '../domain/grammar-evidence/evidence-types';

export interface CreateGrammarEvidenceInput {
  userId: string;
  grammarTopicId: string;
  catalogVersion: number;
  skill: string;
  sourceType: GrammarEvidenceSourceType;
  sourceId: string;
  missionId?: string;
  submissionId?: string;
  reviewId?: string;
  rewriteSubmissionId?: string;
  correctionId?: string;
  evidenceType: GrammarEvidenceType;
  productionMode: GrammarProductionMode;
  outcome: GrammarEvidenceOutcome;
  opportunityWeight: number;
  evidenceWeight: number;
  confidence: number;
  plannedTopic: boolean;
  topicRole: GrammarTopicRole;
  contextKey: string;
  contextFamily: string;
  supportLevel: string;
  helpUsed: boolean;
  occurredAt: string;
  idempotencyKey: string;
  rulesVersion: string;
  metadataJson?: Record<string, unknown>;
}

function rowToEvidence(row: Record<string, unknown>): LearnerGrammarEvidence {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    grammarTopicId: String(row.grammar_topic_id),
    catalogVersion: Number(row.catalog_version ?? 1),
    skill: String(row.skill ?? 'writing'),
    sourceType: String(row.source_type) as GrammarEvidenceSourceType,
    sourceId: String(row.source_id),
    missionId: row.mission_id != null ? String(row.mission_id) : undefined,
    submissionId: row.submission_id != null ? String(row.submission_id) : undefined,
    reviewId: row.review_id != null ? String(row.review_id) : undefined,
    rewriteSubmissionId: row.rewrite_submission_id != null ? String(row.rewrite_submission_id) : undefined,
    correctionId: row.correction_id != null ? String(row.correction_id) : undefined,
    evidenceType: String(row.evidence_type) as GrammarEvidenceType,
    productionMode: String(row.production_mode) as GrammarProductionMode,
    outcome: String(row.outcome) as GrammarEvidenceOutcome,
    opportunityWeight: Number(row.opportunity_weight ?? 1),
    evidenceWeight: Number(row.evidence_weight ?? 0),
    confidence: Number(row.confidence ?? 0.5),
    plannedTopic: Boolean(row.planned_topic),
    topicRole: String(row.topic_role ?? 'unplanned') as GrammarTopicRole,
    contextKey: String(row.context_key),
    contextFamily: String(row.context_family ?? 'unknown'),
    supportLevel: String(row.support_level ?? 'none'),
    helpUsed: Boolean(row.help_used),
    occurredAt: String(row.occurred_at),
    processedAt: String(row.processed_at),
    idempotencyKey: String(row.idempotency_key),
    rulesVersion: String(row.rules_version ?? 'v1'),
    metadataJson: row.metadata_json != null
      ? (row.metadata_json as Record<string, unknown>)
      : undefined,
    createdAt: String(row.created_at),
  };
}

// INSERT with ON CONFLICT (idempotency_key) DO NOTHING; if conflict return existing
export async function createGrammarEvidence(
  supabase: SupabaseClient,
  input: CreateGrammarEvidenceInput,
): Promise<LearnerGrammarEvidence> {
  const payload = {
    user_id: input.userId,
    grammar_topic_id: input.grammarTopicId,
    catalog_version: input.catalogVersion,
    skill: input.skill,
    source_type: input.sourceType,
    source_id: input.sourceId,
    mission_id: input.missionId ?? null,
    submission_id: input.submissionId ?? null,
    review_id: input.reviewId ?? null,
    rewrite_submission_id: input.rewriteSubmissionId ?? null,
    correction_id: input.correctionId ?? null,
    evidence_type: input.evidenceType,
    production_mode: input.productionMode,
    outcome: input.outcome,
    opportunity_weight: input.opportunityWeight,
    evidence_weight: input.evidenceWeight,
    confidence: input.confidence,
    planned_topic: input.plannedTopic,
    topic_role: input.topicRole,
    context_key: input.contextKey,
    context_family: input.contextFamily,
    support_level: input.supportLevel,
    help_used: input.helpUsed,
    occurred_at: input.occurredAt,
    idempotency_key: input.idempotencyKey,
    rules_version: input.rulesVersion,
    metadata_json: input.metadataJson ?? null,
  };

  // Attempt insert; ON CONFLICT idempotency_key → do nothing (use upsert with ignoreDuplicates)
  const { data: inserted, error: insertError } = await supabase
    .from('learner_grammar_evidence')
    .insert(payload)
    .select()
    .maybeSingle();

  if (insertError) {
    // Check if it's a unique violation (duplicate)
    if (insertError.code === '23505' || insertError.message.includes('duplicate') || insertError.message.includes('unique')) {
      // Return existing evidence
      const { data: existing, error: fetchError } = await supabase
        .from('learner_grammar_evidence')
        .select('*')
        .eq('idempotency_key', input.idempotencyKey)
        .single();
      if (fetchError) throw new Error(`createGrammarEvidence (fetch existing): ${fetchError.message}`);
      return rowToEvidence(existing as Record<string, unknown>);
    }
    throw new Error(`createGrammarEvidence: ${insertError.message}`);
  }

  if (!inserted) {
    // Row was silently ignored (ON CONFLICT DO NOTHING via maybeSingle returning null)
    const { data: existing, error: fetchError } = await supabase
      .from('learner_grammar_evidence')
      .select('*')
      .eq('idempotency_key', input.idempotencyKey)
      .single();
    if (fetchError) throw new Error(`createGrammarEvidence (fetch existing after conflict): ${fetchError.message}`);
    return rowToEvidence(existing as Record<string, unknown>);
  }

  return rowToEvidence(inserted as Record<string, unknown>);
}

export async function getGrammarEvidenceForTopic(
  supabase: SupabaseClient,
  userId: string,
  grammarTopicId: string,
): Promise<LearnerGrammarEvidence[]> {
  const { data, error } = await supabase
    .from('learner_grammar_evidence')
    .select('*')
    .eq('user_id', userId)
    .eq('grammar_topic_id', grammarTopicId)
    .order('occurred_at', { ascending: false });

  if (error) throw new Error(`getGrammarEvidenceForTopic: ${error.message}`);
  return (data ?? []).map(row => rowToEvidence(row as Record<string, unknown>));
}

export async function getGrammarEvidenceBySource(
  supabase: SupabaseClient,
  sourceType: GrammarEvidenceSourceType,
  sourceId: string,
): Promise<LearnerGrammarEvidence[]> {
  const { data, error } = await supabase
    .from('learner_grammar_evidence')
    .select('*')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .order('occurred_at', { ascending: false });

  if (error) throw new Error(`getGrammarEvidenceBySource: ${error.message}`);
  return (data ?? []).map(row => rowToEvidence(row as Record<string, unknown>));
}

export async function getRecentEvidenceForTopic(
  supabase: SupabaseClient,
  userId: string,
  grammarTopicId: string,
  windowDays: number,
): Promise<LearnerGrammarEvidence[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('learner_grammar_evidence')
    .select('*')
    .eq('user_id', userId)
    .eq('grammar_topic_id', grammarTopicId)
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false });

  if (error) throw new Error(`getRecentEvidenceForTopic: ${error.message}`);
  return (data ?? []).map(row => rowToEvidence(row as Record<string, unknown>));
}
