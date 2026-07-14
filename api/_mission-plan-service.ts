/**
 * SERVER-ONLY: Orchestration service for the pedagogical planner.
 *
 * Responsibilities:
 * - Check if planning is enabled (feature flag)
 * - Load learner snapshot
 * - Run planWritingMission()
 * - Persist the plan (shadow or full mode)
 * - Log observability events
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { MissionPedagogicalPlan, PlanningMode, MissionDifficulty } from '../src/domain/pedagogy/planner/planner-types';
import { planWritingMission } from '../src/domain/pedagogy/planner/plan-writing-mission';
import { validatePedagogicalPlan } from '../src/domain/pedagogy/planner/planner-validation';
import { GRAMMAR_CATALOG } from '../src/domain/curriculum/grammar-catalog';
import { loadLearnerPlanningSnapshot } from './_learner-planning-snapshot';
import {
  insertMissionPlan,
  getMissionPlanById,
  supersedePlan,
} from './_mission-plan-repository';
import { isPlannerEnabled, isPlannerInShadowMode } from './_mission-plan-feature-flags';
import { safeLog } from './_helpers';

export interface PlanGenerationInput {
  userId: string;
  mode: PlanningMode;
  difficulty?: MissionDifficulty;
  seed: string;
  /** If set and plan already exists with this id, return it (idempotency). */
  existingPlanId?: string;
  previousPlanId?: string;
}

export interface PlanGenerationResult {
  plan: MissionPedagogicalPlan | null;
  planId: string | null;
  /** True when shadow mode is active and the plan should not alter generation. */
  shadowMode: boolean;
  skipped: boolean;
}

/**
 * Main entry point for pedagogical planning.
 * Returns null plan when flag is off or planning fails (graceful degradation).
 */
export async function generatePedagogicalPlan(
  supabase: SupabaseClient,
  input: PlanGenerationInput,
): Promise<PlanGenerationResult> {
  const noop: PlanGenerationResult = { plan: null, planId: null, shadowMode: false, skipped: true };

  if (!isPlannerEnabled()) return noop;

  const shadowMode = isPlannerInShadowMode();

  try {
    // Idempotency: return existing plan if already created for this request
    if (input.existingPlanId) {
      const existing = await getMissionPlanById(supabase, input.existingPlanId);
      if (existing) {
        const plan = existing.full_plan as unknown as MissionPedagogicalPlan;
        logPlannerEvent('mission_plan_reused', input.userId, { plan_id: existing.id, shadow_mode: shadowMode });
        return { plan, planId: existing.id, shadowMode, skipped: false };
      }
    }

    // Supersede previous plan on regeneration
    if (input.previousPlanId) {
      await supersedePlan(input.previousPlanId);
      logPlannerEvent('mission_plan_superseded', input.userId, { previous_plan_id: input.previousPlanId });
    }

    logPlannerEvent('mission_planning_started', input.userId, { mode: input.mode, seed: input.seed });

    const snapshot = await loadLearnerPlanningSnapshot(supabase, input.userId);

    logPlannerEvent('learner_snapshot_loaded', input.userId, {
      grammar_topics_count: snapshot.grammarMastery.length,
      recent_plans_count: snapshot.recentPlans.length,
    });

    const plan = planWritingMission({
      userId: input.userId,
      mode: input.mode,
      difficulty: input.difficulty,
      seed: input.seed,
      snapshot,
      catalog: GRAMMAR_CATALOG,
    });

    const validation = validatePedagogicalPlan(plan);
    if (!validation.valid) {
      logPlannerEvent('mission_planning_failed', input.userId, {
        errors: validation.errors.join('; '),
        seed: input.seed,
      });
      return noop;
    }

    const primaryIds = plan.grammarTopics.filter(t => t.role === 'primary').map(t => t.topicId);
    const secondaryIds = plan.grammarTopics.filter(t => t.role === 'secondary').map(t => t.topicId);
    const reviewIds = plan.grammarTopics.filter(t => t.role === 'review').map(t => t.topicId);
    const forbiddenIds = plan.generationConstraints.forbiddenRequiredTopicIds;

    await insertMissionPlan({
      id: plan.id,
      userId: input.userId,
      skill: 'writing',
      plannerVersion: plan.plannerVersion,
      catalogVersion: plan.catalogVersion,
      learnerLevel: plan.learnerLevel,
      effectiveLevel: plan.effectiveLevel,
      assessmentStatus: plan.assessmentStatus,
      assessmentConfidence: plan.assessmentConfidence,
      mode: plan.mode,
      difficulty: plan.difficulty,
      reason: plan.reason,
      communicativeObjectiveId: plan.communicativeObjectiveId,
      communicativeFunctions: plan.communicativeFunctions,
      primaryTopicIds: primaryIds,
      secondaryTopicIds: secondaryIds,
      reviewTopicIds: reviewIds,
      forbiddenTopicIds: forbiddenIds,
      vocabularyItems: plan.vocabularyItems as unknown as Record<string, unknown>[],
      supportLevel: plan.supportLevel,
      supportConfiguration: plan.supportConfiguration as unknown as Record<string, unknown>,
      noveltyBudget: plan.noveltyBudget as unknown as Record<string, unknown>,
      recoveryBudget: plan.recoveryBudget as unknown as Record<string, unknown>,
      generationConstraints: plan.generationConstraints as unknown as Record<string, unknown>,
      validationRules: plan.validationRules as unknown as Record<string, unknown>,
      fullPlan: plan as unknown as Record<string, unknown>,
      seed: plan.seed,
      shadowMode,
    });

    logPlannerEvent('mission_plan_created', input.userId, {
      plan_id: plan.id,
      effective_level: plan.effectiveLevel,
      difficulty: plan.difficulty,
      reason: plan.reason,
      shadow_mode: shadowMode,
      primary_topics: primaryIds.join(','),
    });

    return { plan, planId: plan.id, shadowMode, skipped: false };

  } catch (err) {
    logPlannerEvent('mission_planning_failed', input.userId, {
      error: String(err).slice(0, 200),
    });
    return noop;
  }
}

function logPlannerEvent(
  event: string,
  userId: string,
  extra?: Record<string, string | number | boolean | null>,
): void {
  safeLog('planner', event, 300, {
    user_id_hash: `u_${userId.slice(0, 8)}`,
    ...extra,
  });
}
