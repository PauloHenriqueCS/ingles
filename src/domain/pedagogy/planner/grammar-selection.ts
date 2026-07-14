import type { CEFRLevel } from '../../curriculum/cefr';
import type { GrammarTopic } from '../../curriculum/grammar-types';
import type { GrammarMasteryState } from '../../learner/grammar-mastery-types';
import type {
  PlannedGrammarTopic,
  GrammarTopicRole,
  LearnerGrammarSnapshot,
  RecentMissionPlan,
} from './planner-types';
import { cefrIndex } from '../../curriculum/cefr';
import { evaluateTopicPrerequisites } from './prerequisite-evaluation';
import { isTopicRecentlyUsedAsPrimary, countRecentPrimaryUses } from './recency-rules';
import { wouldExceedNoveltyBudget, isNewGrammarTopic } from './novelty-budget';
import { isRecoveryCandidate, wouldExceedRecoveryBudget } from './recovery-budget';
import { MAX_PRIMARY_GRAMMAR_TOPICS, MAX_SECONDARY_GRAMMAR_TOPICS } from './planner-constants';
import type { DeterministicRandom } from './deterministic-random';

export interface GrammarSelectionInput {
  effectiveLevel: CEFRLevel;
  isConservative: boolean;
  communicativeObjectiveTopicIds: readonly string[];
  grammarMastery: LearnerGrammarSnapshot[];
  catalog: readonly GrammarTopic[];
  recentPlans: RecentMissionPlan[];
  rng: DeterministicRandom;
}

export interface GrammarSelectionResult {
  topics: PlannedGrammarTopic[];
  forbiddenRequiredTopicIds: string[];
  prerequisitesSatisfied: string[];
  prerequisitesMissing: string[];
}

/**
 * Selects grammar topics for a mission based on learner state, level, and constraints.
 *
 * Selection priority:
 * 1. Objective-compatible topics in practicing/consolidating state (primary)
 * 2. Maintenance-due topics as review
 * 3. Recovery candidates as review
 * 4. Supporting topics from objective (secondary)
 * 5. Exposure-only for locked topics mentioned by objective
 */
export function selectGrammarTopicsForMission(
  input: GrammarSelectionInput,
): GrammarSelectionResult {
  const {
    effectiveLevel,
    isConservative,
    communicativeObjectiveTopicIds,
    grammarMastery,
    catalog,
    recentPlans,
    rng,
  } = input;

  const masteryByTopicId = new Map(grammarMastery.map(m => [m.topicId, m]));
  const catalogById = new Map(catalog.map(t => [t.id, t]));

  const result: PlannedGrammarTopic[] = [];
  const forbiddenRequired: string[] = [];
  const allPrereqsSatisfied: string[] = [];
  const allPrereqsMissing: string[] = [];

  let primaryCount = 0;
  let secondaryCount = 0;
  let reviewCount = 0;
  let newTopicCount = 0;

  // Collect candidates from the communicative objective's topic list
  const objectiveTopics: Array<{
    topicId: string;
    catalogTopic: GrammarTopic;
    mastery: LearnerGrammarSnapshot | undefined;
    score: number;
  }> = [];

  for (const topicId of communicativeObjectiveTopicIds) {
    const catalogTopic = catalogById.get(topicId);
    if (!catalogTopic || !catalogTopic.isActive) continue;

    const levelOk = cefrIndex(catalogTopic.minimumExposureLevel) <= cefrIndex(effectiveLevel);
    if (!levelOk) {
      forbiddenRequired.push(topicId);
      continue;
    }

    const mastery = masteryByTopicId.get(topicId);
    const score = topicSelectionScore(mastery, topicId, recentPlans, isConservative);
    objectiveTopics.push({ topicId, catalogTopic, mastery, score });
  }

  // Sort by score descending
  objectiveTopics.sort((a, b) => b.score - a.score);

  // Select primary topic(s)
  const shuffledCandidates = rng.shuffle([...objectiveTopics]);
  // Sort again by score to preserve priority but with tiebreak randomness
  shuffledCandidates.sort((a, b) => b.score - a.score);

  for (const candidate of shuffledCandidates) {
    const { topicId, catalogTopic, mastery } = candidate;
    const state: GrammarMasteryState = mastery?.state ?? 'locked';

    // Evaluate prerequisites
    const prereqEval = evaluateTopicPrerequisites({
      topicId,
      topicPrerequisiteIds: catalogTopic.prerequisites,
      learnerMastery: grammarMastery,
      requiredPrerequisiteStage: 'guided_practice',
    });

    allPrereqsSatisfied.push(...prereqEval.prerequisitesSatisfied);
    allPrereqsMissing.push(...prereqEval.prerequisitesMissing);

    // Locked → forbidden as requirement, exposure only
    if (state === 'locked') {
      forbiddenRequired.push(topicId);
      const productionLevel = cefrIndex(catalogTopic.minimumGuidedPracticeLevel);
      const exposureLevel = cefrIndex(catalogTopic.minimumExposureLevel);
      if (exposureLevel <= cefrIndex(effectiveLevel) && productionLevel > cefrIndex(effectiveLevel)) {
        result.push(makePlannedTopic(topicId, 'exposure_only', state, ['TOPIC_BLOCKED_BY_LEVEL'], 0));
      }
      continue;
    }

    // Cannot use as production if prerequisites are missing
    if (!prereqEval.canBeUsedAsProduction) {
      if (prereqEval.canBeUsedAsExposureOnly) {
        result.push(makePlannedTopic(topicId, 'exposure_only', state, ['TOPIC_BLOCKED_BY_PREREQUISITE'], 0));
      }
      forbiddenRequired.push(topicId);
      continue;
    }

    // Conservative: skip fragile prerequisites
    if (isConservative && prereqEval.prerequisitesFragile.length > 0) {
      result.push(makePlannedTopic(topicId, 'exposure_only', state, ['PROVISIONAL_LEVEL_CONSERVATIVE'], 0));
      forbiddenRequired.push(topicId);
      continue;
    }

    // Check maintenance due
    if (state === 'maintenance' && mastery?.maintenanceDueAt) {
      const dueDate = new Date(mastery.maintenanceDueAt);
      const now = new Date();
      if (dueDate <= now) {
        if (!wouldExceedRecoveryBudget(effectiveLevel, reviewCount)) {
          result.push(makePlannedTopic(topicId, 'review', state, ['TOPIC_SELECTED_FOR_MAINTENANCE', 'MAINTENANCE_DUE'], 1, true));
          reviewCount++;
          continue;
        }
      }
    }

    // Mastered: avoid overuse, use as secondary or review
    if (state === 'mastered' || state === 'maintenance') {
      if (secondaryCount < MAX_SECONDARY_GRAMMAR_TOPICS) {
        result.push(makePlannedTopic(topicId, 'secondary', state, ['TOPIC_SELECTED_FOR_PRACTICE'], 1, true));
        secondaryCount++;
      }
      continue;
    }

    // Recovery candidate
    if (isRecoveryCandidate(state, mastery?.errorCount ?? 0, mastery?.confidence ?? 1)) {
      if (!wouldExceedRecoveryBudget(effectiveLevel, reviewCount)) {
        result.push(makePlannedTopic(topicId, 'review', state, ['TOPIC_SELECTED_FOR_RECOVERY', 'RECOVERY_PRIORITY'], 2, true));
        reviewCount++;
        continue;
      } else {
        forbiddenRequired.push(topicId);
        continue;
      }
    }

    // Primary selection
    if (primaryCount < MAX_PRIMARY_GRAMMAR_TOPICS) {
      const isNew = isNewGrammarTopic(state);
      if (isNew && wouldExceedNoveltyBudget(effectiveLevel, newTopicCount)) {
        forbiddenRequired.push(topicId);
        result.push(makePlannedTopic(topicId, 'exposure_only', state, ['TOPIC_BLOCKED_BY_NOVELTY_BUDGET'], 0));
        continue;
      }

      if (isTopicRecentlyUsedAsPrimary(topicId, recentPlans) && !isNew) {
        if (secondaryCount < MAX_SECONDARY_GRAMMAR_TOPICS) {
          result.push(makePlannedTopic(topicId, 'secondary', state, ['TOPIC_BLOCKED_BY_RECENCY'], 1, true));
          secondaryCount++;
        }
        continue;
      }

      const reasonCode = masteryStateToReasonCode(state);
      result.push(makePlannedTopic(topicId, 'primary', state, [reasonCode], 2, true));
      primaryCount++;
      if (isNew) newTopicCount++;

    } else if (secondaryCount < MAX_SECONDARY_GRAMMAR_TOPICS) {
      const reasonCode = masteryStateToReasonCode(state);
      result.push(makePlannedTopic(topicId, 'secondary', state, [reasonCode], 1, true));
      secondaryCount++;
    } else {
      // Already have enough topics, mark as forbidden requirement
      forbiddenRequired.push(topicId);
    }
  }

  // All locked topics at or above the effective level → forbidden
  for (const topic of catalog) {
    if (!topic.isActive) continue;
    const state = masteryByTopicId.get(topic.id)?.state ?? 'locked';
    if (state === 'locked') {
      const productionLevel = cefrIndex(topic.minimumIndependentProductionLevel);
      if (productionLevel > cefrIndex(effectiveLevel)) {
        if (!forbiddenRequired.includes(topic.id)) {
          forbiddenRequired.push(topic.id);
        }
      }
    }
  }

  return {
    topics: result,
    forbiddenRequiredTopicIds: [...new Set(forbiddenRequired)],
    prerequisitesSatisfied: [...new Set(allPrereqsSatisfied)],
    prerequisitesMissing: [...new Set(allPrereqsMissing)],
  };
}

function makePlannedTopic(
  topicId: string,
  role: GrammarTopicRole,
  state: GrammarMasteryState,
  reasonCodes: string[],
  requiredOpportunityCount: number,
  explicitInstructionAllowed = false,
): PlannedGrammarTopic {
  return {
    topicId,
    role,
    learnerState: state,
    reasonCodes,
    requiredOpportunityCount,
    explicitInstructionAllowed,
  };
}

function masteryStateToReasonCode(state: GrammarMasteryState): string {
  switch (state) {
    case 'introduced': return 'TOPIC_SELECTED_FOR_INTRODUCTION';
    case 'practicing': return 'TOPIC_SELECTED_FOR_PRACTICE';
    case 'consolidating': return 'TOPIC_SELECTED_FOR_CONSOLIDATION';
    case 'mastered': return 'TOPIC_SELECTED_FOR_PRACTICE';
    case 'maintenance': return 'TOPIC_SELECTED_FOR_MAINTENANCE';
    default: return 'TOPIC_BLOCKED_BY_LEVEL';
  }
}

/** Higher = more preferred. */
function topicSelectionScore(
  mastery: LearnerGrammarSnapshot | undefined,
  topicId: string,
  recentPlans: RecentMissionPlan[],
  isConservative: boolean,
): number {
  if (!mastery) return 0; // locked/unseen → lowest priority

  let score = 0;

  switch (mastery.state) {
    case 'practicing': score = 80; break;
    case 'consolidating': score = 70; break;
    case 'introduced': score = 60; break;
    case 'maintenance': score = 50; break;
    case 'mastered': score = 30; break;
    case 'locked': score = 0; break;
  }

  // Penalize for recent primary use
  const recentUses = countRecentPrimaryUses(topicId, recentPlans);
  score -= recentUses * 15;

  // Boost for low confidence (needs practice)
  if (mastery.confidence < 0.5) score += 10;

  // Conservative profile: prefer well-established topics
  if (isConservative && (mastery.state === 'practicing' || mastery.state === 'introduced')) {
    score -= 10;
  }

  return score;
}
