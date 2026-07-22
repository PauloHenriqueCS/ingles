/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import { createClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../../api/_env';
import type { CEFRLevel } from '../domain/curriculum/cefr';
import type { LearningSkill } from '../domain/learner/learner-skill-types';
import type { SkillPromotionEvaluation } from '../domain/promotion/promotion-types';
import type { PromotionTrigger } from '../domain/promotion/promotion-types';
import { getLearnerSkillProfile } from './learnerProfileRepository';
import { collectSkillEvidence } from './promotionEvidenceCollector';
import { evaluateSkillForPromotion } from './promotionEngine';
import {
  savePromotionEvaluation,
  getEvaluationByIdempotencyKey,
  markPromotionApplied,
} from './promotionEvaluationRepository';

// ── Service-role client factory ───────────────────────────────────────────────

function createServiceSupabase() {
  const { url, key } = getSupabaseServiceCredentials();
  return createClient(url, key);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvaluateSkillPromotionParams {
  userId: string;
  skill: 'writing' | 'pronunciation' | 'conversation';
  trigger: PromotionTrigger;
  idempotencyKey: string;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

export async function evaluateSkillPromotion(
  params: EvaluateSkillPromotionParams,
): Promise<SkillPromotionEvaluation> {
  const { userId, skill, trigger, idempotencyKey } = params;
  const supabase = createServiceSupabase();

  // 1. Idempotency check
  const existing = await getEvaluationByIdempotencyKey(supabase, idempotencyKey);
  if (existing) {
    // Return early with a minimal reconstructed object from saved data
    const { data, error } = await (supabase as ReturnType<typeof createClient>)
      .from('promotion_evaluations')
      .select('*')
      .eq('id', existing.id)
      .single();

    if (!error && data) {
      const row = data as Record<string, unknown>;
      return reconstructEvaluationFromRow(row);
    }
  }

  // 2. Get current skill profile for level
  const profile = await getLearnerSkillProfile(supabase, userId, skill as LearningSkill);
  const currentLevel: CEFRLevel = (profile?.level ?? 'A1') as CEFRLevel;

  // 3. Collect evidence
  const evidenceBundle = await collectSkillEvidence(supabase, userId, skill, currentLevel);

  // 4. Run pure engine
  let evaluation = evaluateSkillForPromotion(evidenceBundle);

  // 5. Apply promotion if decision is 'promote'
  let evaluationId: string | null = null;
  let promotionApplied = false;

  if (evaluation.decision === 'promote' && evaluation.targetLevel != null) {
    const rpcResult = await supabase.rpc('promote_learner_skill_atomic', {
      p_user_id: userId,
      p_skill: skill,
      p_expected_current_level: currentLevel,
      p_new_level: evaluation.targetLevel,
      p_confidence: evaluation.promotionConfidence,
      p_evidence_snapshot: evaluation.evidenceSnapshot,
    });

    if (rpcResult.error) {
      // Treat RPC error as keep_level
      evaluation = {
        ...evaluation,
        decision: 'keep_level',
        eligibleForPromotion: false,
        blockingReasons: [
          ...evaluation.blockingReasons,
          `Promoção atômica falhou: ${rpcResult.error.message}`,
        ],
      };
    } else {
      const rpcData = rpcResult.data as { success: boolean; reason?: string; actual_level?: string } | null;
      if (rpcData && !rpcData.success) {
        evaluation = {
          ...evaluation,
          decision: 'keep_level',
          eligibleForPromotion: false,
          blockingReasons: [
            ...evaluation.blockingReasons,
            `Promoção não aplicada: ${rpcData.reason ?? 'nível alterado concorrentemente'}.`,
          ],
        };
      } else {
        promotionApplied = true;
      }
    }
  }

  // 6. Save evaluation record
  evaluationId = await savePromotionEvaluation(
    supabase,
    evaluation,
    userId,
    skill as LearningSkill,
    idempotencyKey,
    trigger,
  );

  // 7. Mark promotion applied if needed
  if (promotionApplied && evaluationId) {
    await markPromotionApplied(supabase, evaluationId);
  }

  return evaluation;
}

export async function evaluateAllSkillsPromotion(params: {
  userId: string;
  trigger: PromotionTrigger;
}): Promise<SkillPromotionEvaluation[]> {
  const { userId, trigger } = params;
  const skills: Array<'writing' | 'pronunciation' | 'conversation'> = [
    'writing',
    'pronunciation',
    'conversation',
  ];

  const results = await Promise.allSettled(
    skills.map(skill =>
      evaluateSkillPromotion({
        userId,
        skill,
        trigger,
        idempotencyKey: `${userId}:${skill}:${trigger}:${Date.now()}`,
      }),
    ),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<SkillPromotionEvaluation> => r.status === 'fulfilled')
    .map(r => r.value);
}

// ── Helper to reconstruct evaluation from DB row ──────────────────────────────

function reconstructEvaluationFromRow(row: Record<string, unknown>): SkillPromotionEvaluation {
  return {
    userId: String(row.user_id),
    skill: row.skill as LearningSkill,
    currentLevel: String(row.current_level) as CEFRLevel,
    targetLevel: row.target_level != null ? String(row.target_level) as CEFRLevel : null,
    decision: row.decision as SkillPromotionEvaluation['decision'],
    eligibleForPromotion: Boolean(row.eligible),
    promotionConfidence: Number(row.confidence),
    progressPercent: Number(row.progress_percent),
    regressionSignal: 'stable',
    evaluatedAt: String(row.evaluated_at),
    engineVersion: String(row.engine_version),
    curriculumVersion: Number(row.curriculum_version),
    requirements: Array.isArray(row.requirements_json)
      ? row.requirements_json as SkillPromotionEvaluation['requirements']
      : [],
    blockingReasons: Array.isArray(row.blocking_reasons_json)
      ? row.blocking_reasons_json as string[]
      : [],
    summary: '',
    evidenceSnapshot: row.evidence_snapshot_json != null
      ? row.evidence_snapshot_json as Record<string, unknown>
      : {},
  };
}
