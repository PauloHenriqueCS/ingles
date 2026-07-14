import type { MissionPedagogicalPlan } from './planner-types';

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates a completed MissionPedagogicalPlan for internal consistency.
 * Does NOT validate narrative content — that's the mission validator's job.
 */
export function validatePedagogicalPlan(plan: MissionPedagogicalPlan): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan.userId) errors.push('userId is required');
  if (!plan.effectiveLevel) errors.push('effectiveLevel is required');
  if (!plan.difficulty) errors.push('difficulty is required');
  if (!plan.communicativeObjectiveId) errors.push('communicativeObjectiveId is required');
  if (!plan.seed) errors.push('seed is required');

  // Must have at least one primary grammar topic or be in diagnostic/fallback mode
  const primaryTopics = plan.grammarTopics.filter(t => t.role === 'primary');
  if (primaryTopics.length === 0 && plan.reason !== 'initial_safe_fallback' && plan.mode !== 'diagnostic') {
    warnings.push('No primary grammar topic selected — check objective compatibility');
  }

  // Locked topics should not be primary
  const lockedPrimary = plan.grammarTopics.filter(
    t => t.role === 'primary' && t.learnerState === 'locked',
  );
  if (lockedPrimary.length > 0) {
    errors.push(`Topics in locked state selected as primary: ${lockedPrimary.map(t => t.topicId).join(', ')}`);
  }

  // Forbidden topic IDs should not appear as primary or secondary
  const forbiddenInProduction = plan.grammarTopics.filter(
    t =>
      (t.role === 'primary' || t.role === 'secondary') &&
      plan.generationConstraints.forbiddenRequiredTopicIds.includes(t.topicId),
  );
  if (forbiddenInProduction.length > 0) {
    errors.push(`Forbidden topics selected for production: ${forbiddenInProduction.map(t => t.topicId).join(', ')}`);
  }

  // Support configuration must be present
  if (!plan.supportConfiguration) {
    errors.push('supportConfiguration is required');
  }

  // Plan must not contain the final narrative (it's a contract, not content)
  if ('title' in plan || 'setup' in plan || 'task' in plan) {
    errors.push('Plan must not contain narrative content fields (title, setup, task)');
  }

  // Novelty budget check
  const newTopicsCount = plan.grammarTopics.filter(
    t => t.learnerState === 'locked' && (t.role === 'primary' || t.role === 'secondary'),
  ).length;
  if (newTopicsCount > plan.noveltyBudget.maximumNewGrammarTopics) {
    errors.push(`Novelty budget exceeded: ${newTopicsCount} new topics vs max ${plan.noveltyBudget.maximumNewGrammarTopics}`);
  }

  // Recovery budget check
  const reviewTopicsCount = plan.grammarTopics.filter(t => t.role === 'review').length;
  if (reviewTopicsCount > plan.recoveryBudget.maximumGrammarReviewTopics) {
    errors.push(`Recovery budget exceeded: ${reviewTopicsCount} review topics vs max ${plan.recoveryBudget.maximumGrammarReviewTopics}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
