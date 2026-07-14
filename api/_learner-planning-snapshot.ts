/**
 * SERVER-ONLY: Loads a consistent learner planning snapshot for the planner.
 * Single read per generation request — avoids inconsistent multi-read patterns.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { LearnerPlanningSnapshot, LearnerGrammarSnapshot, RecentMissionPlan, CEFRLevel } from '../src/domain/pedagogy/planner/planner-types';
import { CATALOG_VERSION } from '../src/domain/curriculum/grammar-catalog';
import { RECENT_PLAN_WINDOW } from '../src/domain/pedagogy/planner/planner-constants';
import { getRecentPlansForUser } from './_mission-plan-repository';

/**
 * Loads a consistent learner planning snapshot.
 * Uses parallel queries for performance; single coherent snapshot returned.
 */
export async function loadLearnerPlanningSnapshot(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerPlanningSnapshot> {
  const [profileResult, masteryResult, recentPlansResult] = await Promise.all([
    loadWritingProfile(supabase, userId),
    loadGrammarMastery(supabase, userId),
    getRecentPlansForUser(supabase, userId, RECENT_PLAN_WINDOW),
  ]);

  const recentPlans: RecentMissionPlan[] = recentPlansResult.map(row => ({
    communicativeObjectiveId: row.communicative_objective_id,
    primaryTopicIds: row.primary_topic_ids,
    contextFamilies: (row.generation_constraints as Record<string, unknown>)?.avoidedContextFamilies as string[] ?? [],
    createdAt: row.created_at,
  }));

  return {
    userId,
    snapshotVersion: `${CATALOG_VERSION}`,
    capturedAt: new Date().toISOString(),
    writingProfile: profileResult,
    grammarMastery: masteryResult,
    recentPlans,
    catalogVersion: CATALOG_VERSION,
  };
}

async function loadWritingProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerPlanningSnapshot['writingProfile']> {
  const { data, error } = await supabase
    .from('learner_skill_profiles')
    .select('cefr_level, assessment_status, confidence')
    .eq('user_id', userId)
    .eq('skill', 'writing')
    .single();

  if (error || !data) return null;

  return {
    level: (data.cefr_level as CEFRLevel | null) ?? null,
    status: data.assessment_status,
    confidence: data.confidence ?? 0,
  };
}

async function loadGrammarMastery(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerGrammarSnapshot[]> {
  const { data, error } = await supabase
    .from('learner_grammar_mastery')
    .select(
      'grammar_topic_id, state, confidence, maintenance_due_at, last_practiced_at, error_count, distinct_context_count',
    )
    .eq('user_id', userId);

  if (error || !data) return [];

  return data.map(row => ({
    topicId: row.grammar_topic_id,
    state: row.state,
    confidence: row.confidence ?? 0,
    maintenanceDueAt: row.maintenance_due_at ?? null,
    lastPracticedAt: row.last_practiced_at ?? null,
    errorCount: row.error_count ?? 0,
    distinctContextCount: row.distinct_context_count ?? 0,
  }));
}
