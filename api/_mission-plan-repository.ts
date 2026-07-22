/**
 * SERVER-ONLY: Repository for mission_pedagogical_plans table.
 * Never import in client-side code (src/).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from './_env';

function createServiceClient(): SupabaseClient {
  const { url, key } = getSupabaseServiceCredentials();
  return createClient(url, key);
}

export interface MissionPlanRow {
  id: string;
  user_id: string;
  skill: 'writing';
  planner_version: string;
  catalog_version: number;
  learner_level: string | null;
  effective_level: string;
  assessment_status: string;
  assessment_confidence: number;
  mode: string;
  difficulty: string;
  reason: string;
  communicative_objective_id: string;
  communicative_functions: string[];
  primary_topic_ids: string[];
  secondary_topic_ids: string[];
  review_topic_ids: string[];
  forbidden_topic_ids: string[];
  vocabulary_items: Record<string, unknown>[];
  support_level: string;
  support_configuration: Record<string, unknown>;
  novelty_budget: Record<string, unknown>;
  recovery_budget: Record<string, unknown>;
  generation_constraints: Record<string, unknown>;
  validation_rules: Record<string, unknown>;
  full_plan: Record<string, unknown>;
  seed: string;
  shadow_mode: boolean;
  created_at: string;
  accepted_at: string | null;
  superseded_at: string | null;
}

export interface InsertMissionPlanParams {
  id: string;
  userId: string;
  skill: 'writing';
  plannerVersion: string;
  catalogVersion: number;
  learnerLevel: string | null;
  effectiveLevel: string;
  assessmentStatus: string;
  assessmentConfidence: number;
  mode: string;
  difficulty: string;
  reason: string;
  communicativeObjectiveId: string;
  communicativeFunctions: string[];
  primaryTopicIds: string[];
  secondaryTopicIds: string[];
  reviewTopicIds: string[];
  forbiddenTopicIds: string[];
  vocabularyItems: Record<string, unknown>[];
  supportLevel: string;
  supportConfiguration: Record<string, unknown>;
  noveltyBudget: Record<string, unknown>;
  recoveryBudget: Record<string, unknown>;
  generationConstraints: Record<string, unknown>;
  validationRules: Record<string, unknown>;
  fullPlan: Record<string, unknown>;
  seed: string;
  shadowMode: boolean;
}

export async function insertMissionPlan(
  params: InsertMissionPlanParams,
): Promise<MissionPlanRow | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('mission_pedagogical_plans')
    .insert({
      id: params.id,
      user_id: params.userId,
      skill: params.skill,
      planner_version: params.plannerVersion,
      catalog_version: params.catalogVersion,
      learner_level: params.learnerLevel,
      effective_level: params.effectiveLevel,
      assessment_status: params.assessmentStatus,
      assessment_confidence: params.assessmentConfidence,
      mode: params.mode,
      difficulty: params.difficulty,
      reason: params.reason,
      communicative_objective_id: params.communicativeObjectiveId,
      communicative_functions: params.communicativeFunctions,
      primary_topic_ids: params.primaryTopicIds,
      secondary_topic_ids: params.secondaryTopicIds,
      review_topic_ids: params.reviewTopicIds,
      forbidden_topic_ids: params.forbiddenTopicIds,
      vocabulary_items: params.vocabularyItems,
      support_level: params.supportLevel,
      support_configuration: params.supportConfiguration,
      novelty_budget: params.noveltyBudget,
      recovery_budget: params.recoveryBudget,
      generation_constraints: params.generationConstraints,
      validation_rules: params.validationRules,
      full_plan: params.fullPlan,
      seed: params.seed,
      shadow_mode: params.shadowMode,
    })
    .select()
    .single();

  if (error) {
    // Idempotency: unique constraint violation (same id) → fetch existing
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('mission_pedagogical_plans')
        .select()
        .eq('id', params.id)
        .single();
      return existing ?? null;
    }
    return null;
  }

  return data ?? null;
}

export async function getMissionPlanById(
  supabase: SupabaseClient,
  planId: string,
): Promise<MissionPlanRow | null> {
  const { data, error } = await supabase
    .from('mission_pedagogical_plans')
    .select()
    .eq('id', planId)
    .single();

  if (error) return null;
  return data ?? null;
}

export async function getLatestPlanForUser(
  supabase: SupabaseClient,
  userId: string,
  skill: 'writing' = 'writing',
): Promise<MissionPlanRow | null> {
  const { data, error } = await supabase
    .from('mission_pedagogical_plans')
    .select()
    .eq('user_id', userId)
    .eq('skill', skill)
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) return null;
  return data ?? null;
}

export async function supersedePlan(
  planId: string,
): Promise<boolean> {
  const supabase = createServiceClient();

  const { error } = await supabase
    .from('mission_pedagogical_plans')
    .update({ superseded_at: new Date().toISOString() })
    .eq('id', planId)
    .is('superseded_at', null);

  return !error;
}

export async function markPlanAccepted(
  planId: string,
): Promise<boolean> {
  const supabase = createServiceClient();

  const { error } = await supabase
    .from('mission_pedagogical_plans')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', planId)
    .is('accepted_at', null);

  return !error;
}

/** Fetches recent plans (non-superseded) for recency analysis. */
export async function getRecentPlansForUser(
  supabase: SupabaseClient,
  userId: string,
  limit: number,
): Promise<MissionPlanRow[]> {
  const { data, error } = await supabase
    .from('mission_pedagogical_plans')
    .select()
    .eq('user_id', userId)
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return data ?? [];
}
