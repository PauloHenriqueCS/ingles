import type { CEFRLevel } from '../../curriculum/cefr';
import type { GrammarMasteryState } from '../../learner/grammar-mastery-types';
import type { NoveltyBudget } from './planner-types';
import { NOVELTY_BUDGETS } from './planner-constants';

/** Returns the novelty budget for a given CEFR level. */
export function getNoveltyBudget(level: CEFRLevel): NoveltyBudget {
  return NOVELTY_BUDGETS[level];
}

/** A topic is considered "new" if the learner has never seen it (locked state). */
export function isNewGrammarTopic(state: GrammarMasteryState): boolean {
  return state === 'locked';
}

/**
 * Counts how many "new" (locked) topics are currently planned as primary or secondary.
 */
export function countNewTopicsInPlan(
  plannedTopicStates: GrammarMasteryState[],
): number {
  return plannedTopicStates.filter(s => s === 'locked').length;
}

/**
 * Returns true if adding another new grammar topic would exceed the budget.
 */
export function wouldExceedNoveltyBudget(
  level: CEFRLevel,
  currentNewTopicsCount: number,
): boolean {
  return currentNewTopicsCount >= getNoveltyBudget(level).maximumNewGrammarTopics;
}

/**
 * Returns true if adding another new vocabulary item would exceed the budget.
 */
export function wouldExceedVocabularyNoveltyBudget(
  level: CEFRLevel,
  currentNewVocabCount: number,
): boolean {
  return currentNewVocabCount >= getNoveltyBudget(level).maximumNewVocabularyItems;
}
