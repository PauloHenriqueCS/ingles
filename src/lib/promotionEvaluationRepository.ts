/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LearningSkill } from '../domain/learner/learner-skill-types';
import type { SkillPromotionEvaluation } from '../domain/promotion/promotion-types';
import type { PromotionTrigger } from '../domain/promotion/promotion-types';

// ── Row type ──────────────────────────────────────────────────────────────────

export interface PromotionEvaluationRow {
  id: string;
  userId: string;
  skill: LearningSkill;
  currentLevel: string;
  targetLevel: string | null;
  decision: string;
  eligible: boolean;
  confidence: number;
  progressPercent: number;
  requirementsJson: unknown[];
  blockingReasonsJson: string[];
  evidenceSnapshotJson: Record<string, unknown> | null;
  engineVersion: string;
  curriculumVersion: number;
  idempotencyKey: string;
  triggerSource: string;
  promotionApplied: boolean;
  evaluatedAt: string;
  createdAt: string;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToEvaluationRow(row: Record<string, unknown>): PromotionEvaluationRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    skill: row.skill as LearningSkill,
    currentLevel: String(row.current_level),
    targetLevel: row.target_level != null ? String(row.target_level) : null,
    decision: String(row.decision),
    eligible: Boolean(row.eligible),
    confidence: Number(row.confidence),
    progressPercent: Number(row.progress_percent),
    requirementsJson: Array.isArray(row.requirements_json) ? row.requirements_json as unknown[] : [],
    blockingReasonsJson: Array.isArray(row.blocking_reasons_json) ? row.blocking_reasons_json as string[] : [],
    evidenceSnapshotJson: row.evidence_snapshot_json != null ? row.evidence_snapshot_json as Record<string, unknown> : null,
    engineVersion: String(row.engine_version),
    curriculumVersion: Number(row.curriculum_version),
    idempotencyKey: String(row.idempotency_key),
    triggerSource: String(row.trigger_source),
    promotionApplied: Boolean(row.promotion_applied),
    evaluatedAt: String(row.evaluated_at),
    createdAt: String(row.created_at),
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function savePromotionEvaluation(
  supabase: SupabaseClient,
  evaluation: SkillPromotionEvaluation,
  userId: string,
  skill: LearningSkill,
  idempotencyKey: string,
  triggerSource: PromotionTrigger,
): Promise<string> {
  const payload = {
    user_id: userId,
    skill,
    current_level: evaluation.currentLevel,
    target_level: evaluation.targetLevel ?? null,
    decision: evaluation.decision,
    eligible: evaluation.eligibleForPromotion,
    confidence: evaluation.promotionConfidence,
    progress_percent: evaluation.progressPercent,
    requirements_json: evaluation.requirements,
    blocking_reasons_json: evaluation.blockingReasons,
    evidence_snapshot_json: evaluation.evidenceSnapshot,
    engine_version: evaluation.engineVersion,
    curriculum_version: evaluation.curriculumVersion,
    idempotency_key: idempotencyKey,
    trigger_source: triggerSource,
    promotion_applied: false,
    evaluated_at: evaluation.evaluatedAt,
  };

  const { data, error } = await supabase
    .from('promotion_evaluations')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw new Error(`savePromotionEvaluation: ${error.message}`);
  return String((data as Record<string, unknown>).id);
}

export async function getEvaluationByIdempotencyKey(
  supabase: SupabaseClient,
  idempotencyKey: string,
): Promise<{ id: string; decision: string } | null> {
  const { data, error } = await supabase
    .from('promotion_evaluations')
    .select('id, decision')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) throw new Error(`getEvaluationByIdempotencyKey: ${error.message}`);
  if (!data) return null;

  const row = data as Record<string, unknown>;
  return { id: String(row.id), decision: String(row.decision) };
}

export async function markPromotionApplied(
  supabase: SupabaseClient,
  evaluationId: string,
): Promise<void> {
  const { error } = await supabase
    .from('promotion_evaluations')
    .update({ promotion_applied: true })
    .eq('id', evaluationId);

  if (error) throw new Error(`markPromotionApplied: ${error.message}`);
}

export async function getEvaluationsForSkill(
  supabase: SupabaseClient,
  userId: string,
  skill: LearningSkill,
  limit = 10,
): Promise<PromotionEvaluationRow[]> {
  const { data, error } = await supabase
    .from('promotion_evaluations')
    .select('*')
    .eq('user_id', userId)
    .eq('skill', skill)
    .order('evaluated_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getEvaluationsForSkill: ${error.message}`);
  return (data ?? []).map(row => rowToEvaluationRow(row as Record<string, unknown>));
}
