import type { CEFRLevel } from '../../curriculum/cefr';
import type { GrammarMasteryState } from '../../learner/grammar-mastery-types';
import type { RecoveryBudget } from './planner-types';
import { RECOVERY_BUDGETS } from './planner-constants';

/** Returns the recovery budget for a given CEFR level. */
export function getRecoveryBudget(level: CEFRLevel): RecoveryBudget {
  return RECOVERY_BUDGETS[level];
}

/** A topic is a "recovery" candidate if there are significant errors or low confidence after practice. */
export function isRecoveryCandidate(
  state: GrammarMasteryState,
  errorCount: number,
  confidence: number,
): boolean {
  if (state === 'locked' || state === 'introduced') return false;
  return errorCount >= 3 || confidence < 0.35;
}

/**
 * Returns true if adding another recovery grammar topic would exceed the budget.
 */
export function wouldExceedRecoveryBudget(
  level: CEFRLevel,
  currentReviewTopicsCount: number,
): boolean {
  return currentReviewTopicsCount >= getRecoveryBudget(level).maximumGrammarReviewTopics;
}

/**
 * Returns true if adding another vocabulary review item would exceed the budget.
 */
export function wouldExceedVocabularyRecoveryBudget(
  level: CEFRLevel,
  currentReviewVocabCount: number,
): boolean {
  return currentReviewVocabCount >= getRecoveryBudget(level).maximumVocabularyReviewItems;
}
