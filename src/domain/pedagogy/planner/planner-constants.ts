import type { CEFRLevel } from '../../curriculum/cefr';
import type { NoveltyBudget, RecoveryBudget } from './planner-types';

export const PLANNER_VERSION = 'v1' as const;

export const RECENT_PLAN_WINDOW = 10;

export const NOVELTY_BUDGETS: Record<CEFRLevel, NoveltyBudget> = {
  A1: { maximumNewGrammarTopics: 1, maximumNewVocabularyItems: 3 },
  A2: { maximumNewGrammarTopics: 1, maximumNewVocabularyItems: 4 },
  B1: { maximumNewGrammarTopics: 2, maximumNewVocabularyItems: 5 },
  B2: { maximumNewGrammarTopics: 2, maximumNewVocabularyItems: 6 },
  C1: { maximumNewGrammarTopics: 3, maximumNewVocabularyItems: 8 },
  C2: { maximumNewGrammarTopics: 3, maximumNewVocabularyItems: 8 },
};

export const RECOVERY_BUDGETS: Record<CEFRLevel, RecoveryBudget> = {
  A1: { maximumGrammarReviewTopics: 1, maximumVocabularyReviewItems: 2 },
  A2: { maximumGrammarReviewTopics: 1, maximumVocabularyReviewItems: 2 },
  B1: { maximumGrammarReviewTopics: 2, maximumVocabularyReviewItems: 3 },
  B2: { maximumGrammarReviewTopics: 2, maximumVocabularyReviewItems: 3 },
  C1: { maximumGrammarReviewTopics: 3, maximumVocabularyReviewItems: 4 },
  C2: { maximumGrammarReviewTopics: 3, maximumVocabularyReviewItems: 4 },
};

/** Maximum topics selectable as primary per mission. */
export const MAX_PRIMARY_GRAMMAR_TOPICS = 1;

/** Maximum topics selectable as secondary per mission. */
export const MAX_SECONDARY_GRAMMAR_TOPICS = 2;

/** Minimum confidence threshold to treat state as reliable. */
export const MIN_RELIABLE_CONFIDENCE = 0.5;

/** Stale profile: months since last assessment before using conservative approach. */
export const STALE_PROFILE_MONTHS = 3;

/** Safe fallback CEFR level used when user has no profile. */
export const SAFE_FALLBACK_LEVEL: CEFRLevel = 'A1';

/** Default difficulty for diagnostic/unknown mode. */
export const FALLBACK_DIFFICULTY = 'easy' as const;

/** How many recent plans to check for objective repetition. */
export const OBJECTIVE_RECENCY_WINDOW = 5;

/** How many recent plans to check for topic overuse. */
export const TOPIC_RECENCY_WINDOW = 7;

/** How many recent plans to check for context family overuse. */
export const CONTEXT_RECENCY_WINDOW = 5;

/** Minimum days since maintenance was last reviewed before selecting it. */
export const MAINTENANCE_ELIGIBILITY_DAYS = 14;
