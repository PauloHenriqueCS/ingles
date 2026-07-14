/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { LearnerSkillProfile, LearnerSkillLevelHistory, LearningSkill } from '../domain/learner/learner-skill-types';
import { CEFRLevel } from '../domain/curriculum/cefr';
import { SkillAssessmentStatus, SkillLevelSource } from '../domain/learner/learner-skill-types';

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToProfile(row: Record<string, unknown>): LearnerSkillProfile {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    skill: row.skill as LearningSkill,
    level: row.cefr_level != null ? (String(row.cefr_level) as CEFRLevel) : null,
    status: String(row.assessment_status) as SkillAssessmentStatus,
    confidence: Number(row.confidence),
    source: String(row.source) as SkillLevelSource,
    evidenceCount: Number(row.evidence_count ?? 0),
    catalogVersion: Number(row.catalog_version ?? 1),
    assessedAt: row.assessed_at != null ? String(row.assessed_at) : null,
    calibratedAt: row.calibrated_at != null ? String(row.calibrated_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function getLearnerSkillProfiles(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerSkillProfile[]> {
  const { data, error } = await supabase
    .from('learner_skill_profiles')
    .select('*')
    .eq('user_id', userId);

  if (error) throw new Error(`getLearnerSkillProfiles: ${error.message}`);
  return (data ?? []).map(row => rowToProfile(row as Record<string, unknown>));
}

export async function getLearnerSkillProfile(
  supabase: SupabaseClient,
  userId: string,
  skill: LearningSkill,
): Promise<LearnerSkillProfile | null> {
  const { data, error } = await supabase
    .from('learner_skill_profiles')
    .select('*')
    .eq('user_id', userId)
    .eq('skill', skill)
    .maybeSingle();

  if (error) throw new Error(`getLearnerSkillProfile: ${error.message}`);
  if (!data) return null;
  return rowToProfile(data as Record<string, unknown>);
}

export async function upsertLearnerSkillProfile(
  supabase: SupabaseClient,
  profile: Omit<LearnerSkillProfile, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<LearnerSkillProfile> {
  const payload = {
    user_id: profile.userId,
    skill: profile.skill,
    cefr_level: profile.level,
    assessment_status: profile.status,
    confidence: profile.confidence,
    source: profile.source,
    evidence_count: profile.evidenceCount,
    catalog_version: profile.catalogVersion,
    assessed_at: profile.assessedAt,
    calibrated_at: profile.calibratedAt,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('learner_skill_profiles')
    .upsert(payload, { onConflict: 'user_id,skill' })
    .select()
    .single();

  if (error) throw new Error(`upsertLearnerSkillProfile: ${error.message}`);
  return rowToProfile(data as Record<string, unknown>);
}

export async function insertSkillLevelHistory(
  supabase: SupabaseClient,
  entry: Omit<LearnerSkillLevelHistory, 'id'>,
): Promise<void> {
  const { error } = await supabase.from('learner_skill_level_history').insert({
    user_id: entry.userId,
    skill: entry.skill,
    previous_level: entry.previousLevel,
    new_level: entry.newLevel,
    previous_status: entry.previousStatus,
    new_status: entry.newStatus,
    previous_confidence: entry.previousConfidence,
    new_confidence: entry.newConfidence,
    source: entry.source,
    reason_code: entry.reasonCode,
    evidence_snapshot: entry.evidenceSnapshot ?? null,
    changed_at: entry.changedAt,
  });

  if (error) throw new Error(`insertSkillLevelHistory: ${error.message}`);
}
