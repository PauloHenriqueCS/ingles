import type { CEFRLevel } from '../../curriculum/cefr';
import type { PlannedVocabularyItem } from './planner-types';
import { getRecoveryBudget } from './recovery-budget';
import { getNoveltyBudget } from './novelty-budget';

export interface VocabularyMasterySnapshot {
  vocabularyItemId: string;
  normalizedValue: string;
  state: 'unseen' | 'seen' | 'recognized' | 'practiced' | 'mastered';
  errorCount: number;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
}

export interface VocabularySelectionInput {
  level: CEFRLevel;
  objectiveContextFamilies: readonly string[];
  learnerVocabularyState: VocabularyMasterySnapshot[];
  recentErrors: string[];
  recentPlansVocabIds: string[];
}

/**
 * Selects vocabulary items for a mission based on the learner's state and objective.
 * Enforces novelty and recovery budgets.
 * Does NOT mark items as learned — word appearing on screen ≠ learned.
 */
export function selectVocabularyForMission(
  input: VocabularySelectionInput,
): PlannedVocabularyItem[] {
  const items: PlannedVocabularyItem[] = [];
  const noveltyBudget = getNoveltyBudget(input.level);
  const recoveryBudget = getRecoveryBudget(input.level);

  let newVocabCount = 0;
  let reviewVocabCount = 0;

  // 1. Priority: error recovery items (seen before, high error rate)
  const errorItems = input.learnerVocabularyState
    .filter(v =>
      v.errorCount >= 2 &&
      v.state !== 'unseen' &&
      !input.recentPlansVocabIds.includes(v.vocabularyItemId),
    )
    .slice(0, recoveryBudget.maximumVocabularyReviewItems);

  for (const item of errorItems) {
    if (reviewVocabCount >= recoveryBudget.maximumVocabularyReviewItems) break;
    items.push({
      vocabularyItemId: item.vocabularyItemId,
      normalizedValue: item.normalizedValue,
      role: 'review',
      required: false,
      reasonCodes: ['VOCABULARY_SELECTED_FOR_REVIEW'],
    });
    reviewVocabCount++;
  }

  // 2. Support vocabulary: already seen items relevant to context
  const supportItems = input.learnerVocabularyState
    .filter(v =>
      v.state === 'seen' || v.state === 'recognized' || v.state === 'practiced',
    )
    .filter(v => !items.some(i => i.vocabularyItemId === v.vocabularyItemId))
    .slice(0, 3);

  for (const item of supportItems) {
    items.push({
      vocabularyItemId: item.vocabularyItemId,
      normalizedValue: item.normalizedValue,
      role: 'support',
      required: false,
      reasonCodes: [],
    });
  }

  // 3. Optional stretch: unseen items that fit the level
  const unseenItems = input.learnerVocabularyState
    .filter(v => v.state === 'unseen')
    .filter(v => !items.some(i => i.vocabularyItemId === v.vocabularyItemId));

  for (const item of unseenItems) {
    if (newVocabCount >= noveltyBudget.maximumNewVocabularyItems) break;
    items.push({
      vocabularyItemId: item.vocabularyItemId,
      normalizedValue: item.normalizedValue,
      role: 'optional_stretch',
      required: false,
      reasonCodes: [],
    });
    newVocabCount++;
  }

  return items;
}

/**
 * Validates whether a vocabulary item can be marked as required.
 * A word can only be required when it meets all the listed criteria.
 */
export function canBeRequiredVocabulary(
  item: VocabularyMasterySnapshot,
  level: CEFRLevel,
  otherRequiredCount: number,
): boolean {
  // Must have been seen before
  if (item.state === 'unseen') return false;
  // Must have some evidence of recognition
  if (item.state === 'seen' && item.errorCount > 2) return false;
  // Don't pile up required items
  const maxRequired = level === 'A1' || level === 'A2' ? 1 : 2;
  if (otherRequiredCount >= maxRequired) return false;
  return true;
}
