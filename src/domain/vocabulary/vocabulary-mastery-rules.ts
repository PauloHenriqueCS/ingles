import type { VocabularyLearningState } from './vocabulary-types';
import type { VocabularyMasteryReasonCode } from './vocabulary-reason-codes';

export const VOCABULARY_MASTERY_CRITERIA_V1 = {
  minSuccessfulRecalls: 3,
  minIndependentUses: 2,
  minDistinctContexts: 2,
  minRetentionSuccesses: 1,
  minConfidence: 0.75,
  maxRecentLapses: 0,  // no lapse in last 14 days
} as const;

export const VOCABULARY_LAPSE_CRITERIA_V1 = {
  masteredLapseGoesToReviewing: true,
  maintenanceLapseGoesToReviewing: true,
  reviewingLapseStaysReviewing: true,
} as const;

export interface MasteryEligibilityInput {
  successfulRecalls: number;
  successfulUses: number;
  independentUses: number;
  distinctContextCount: number;
  retentionSuccesses: number;
  lapseCount: number;
  recentLapseCount: number;  // lapses in last 14 days
  confidence: number;
  currentState: VocabularyLearningState;
}

export interface MasteryEligibilityResult {
  eligible: boolean;
  blockedReasons: string[];
  reasonCode: VocabularyMasteryReasonCode | null;
}

export function evaluateMasteryEligibility(input: MasteryEligibilityInput): MasteryEligibilityResult {
  const criteria = VOCABULARY_MASTERY_CRITERIA_V1;
  const blockedReasons: string[] = [];

  const totalRecalls = input.successfulRecalls + input.successfulUses;

  if (totalRecalls < criteria.minSuccessfulRecalls) {
    blockedReasons.push(
      `Need ${criteria.minSuccessfulRecalls} successful recalls/uses, have ${totalRecalls}`,
    );
  }

  if (input.independentUses < criteria.minIndependentUses) {
    blockedReasons.push(
      `Need ${criteria.minIndependentUses} independent uses, have ${input.independentUses}`,
    );
  }

  if (input.distinctContextCount < criteria.minDistinctContexts) {
    blockedReasons.push(
      `Need ${criteria.minDistinctContexts} distinct contexts, have ${input.distinctContextCount}`,
    );
  }

  if (input.retentionSuccesses < criteria.minRetentionSuccesses) {
    blockedReasons.push(
      `Need ${criteria.minRetentionSuccesses} retention success(es), have ${input.retentionSuccesses}`,
    );
  }

  if (input.recentLapseCount > criteria.maxRecentLapses) {
    blockedReasons.push(
      `Had ${input.recentLapseCount} lapse(s) in last 14 days (max allowed: ${criteria.maxRecentLapses})`,
    );
  }

  if (input.confidence < criteria.minConfidence) {
    blockedReasons.push(
      `Confidence ${input.confidence.toFixed(3)} below minimum ${criteria.minConfidence}`,
    );
  }

  if (blockedReasons.length === 0) {
    return {
      eligible: true,
      blockedReasons: [],
      reasonCode: 'ITEM_MASTERED',
    };
  }

  return {
    eligible: false,
    blockedReasons,
    reasonCode: null,
  };
}

export function determineLapseTransition(
  currentState: VocabularyLearningState,
): VocabularyLearningState {
  switch (currentState) {
    case 'mastered':
      return 'reviewing';
    case 'maintenance':
      return 'reviewing';
    case 'reviewing':
      return 'reviewing'; // stays
    case 'learning':
      return 'learning'; // stays
    case 'introduced':
      return 'learning'; // first exposure + lapse = now learning
    case 'new':
      return 'learning';
    case 'suspended':
      return 'suspended'; // don't change
    default:
      return currentState;
  }
}
