import type { GrammarMasteryState } from '../../learner/grammar-mastery-types';
import type { LearnerGrammarSnapshot } from './planner-types';

export type PrerequisiteStage = 'exposure' | 'guided_practice' | 'independent_production';

export interface PrerequisiteEvaluationResult {
  topicId: string;
  canBeUsedAsProduction: boolean;
  canBeUsedAsExposureOnly: boolean;
  prerequisitesSatisfied: string[];
  prerequisitesMissing: string[];
  prerequisitesFragile: string[];
  reasonCodes: string[];
}

const STATE_RANK: Record<GrammarMasteryState, number> = {
  locked: 0,
  introduced: 1,
  practicing: 2,
  consolidating: 3,
  mastered: 4,
  maintenance: 4,
};

/** Returns true if the learner's mastery state meets the minimum required stage. */
export function stateAtLeast(state: GrammarMasteryState, minimum: GrammarMasteryState): boolean {
  return STATE_RANK[state] >= STATE_RANK[minimum];
}

/**
 * Evaluates whether a topic can be selected for production given the learner's mastery profile.
 *
 * Prerequisite stages:
 * - 'introduced'    → prerequisite has been seen at least once (introduced/practicing/consolidating/mastered)
 * - 'practicing'    → prerequisite is actively being practiced or better
 * - 'consolidating' → prerequisite is consolidating or better (mastered/maintenance)
 */
export function evaluateTopicPrerequisites(params: {
  topicId: string;
  topicPrerequisiteIds: readonly string[];
  learnerMastery: LearnerGrammarSnapshot[];
  requiredPrerequisiteStage: PrerequisiteStage;
}): PrerequisiteEvaluationResult {
  const { topicId, topicPrerequisiteIds, learnerMastery, requiredPrerequisiteStage } = params;
  const masteryByTopicId = new Map(learnerMastery.map(m => [m.topicId, m]));

  const satisfied: string[] = [];
  const missing: string[] = [];
  const fragile: string[] = [];
  const reasonCodes: string[] = [];

  const minimumState = stageToMinimumState(requiredPrerequisiteStage);

  for (const prereqId of topicPrerequisiteIds) {
    const mastery = masteryByTopicId.get(prereqId);
    if (!mastery) {
      missing.push(prereqId);
      reasonCodes.push('PREREQUISITE_ABSENT');
      continue;
    }

    if (mastery.state === 'locked') {
      missing.push(prereqId);
      reasonCodes.push('PREREQUISITE_ABSENT');
      continue;
    }

    if (!stateAtLeast(mastery.state, minimumState)) {
      fragile.push(prereqId);
      reasonCodes.push('PREREQUISITE_FRAGILE');
      continue;
    }

    if (mastery.confidence < 0.3) {
      fragile.push(prereqId);
      reasonCodes.push('PREREQUISITE_FRAGILE');
      continue;
    }

    satisfied.push(prereqId);
  }

  const canBeUsedAsProduction = missing.length === 0 && fragile.length === 0;
  const canBeUsedAsExposureOnly = missing.length === 0;

  return {
    topicId,
    canBeUsedAsProduction,
    canBeUsedAsExposureOnly,
    prerequisitesSatisfied: satisfied,
    prerequisitesMissing: missing,
    prerequisitesFragile: fragile,
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function stageToMinimumState(stage: PrerequisiteStage): GrammarMasteryState {
  switch (stage) {
    case 'exposure': return 'introduced';
    case 'guided_practice': return 'practicing';
    case 'independent_production': return 'consolidating';
  }
}
