import type { CEFRLevel } from '../curriculum/cefr';

export const PROMOTION_ENGINE_VERSION = 'v1.0.0';
export const PROMOTION_CURRICULUM_VERSION = 1;

export const MIN_VALID_MISSIONS_BY_LEVEL: Record<string, number> = {
  A1: 8, A2: 8, B1: 10, B2: 10, C1: 12,
};

export const PROMOTION_RULES = {
  minimumEssentialTopicCoverage: 0.75,    // 75% of essential topics mastered
  prerequisiteCoverage: 1.0,              // 100% prerequisites mastered
  minimumObjectiveAccuracy: 0.80,         // 80% weighted accuracy
  minimumDistinctContexts: 3,             // 3 distinct context families
  requiredCheckpointPasses: 2,            // must pass 2 of 3
  requiredCompletedCheckpoints: 3,        // must complete all 3
  minimumConfidence: 0.80,               // 80% confidence
  minimumDistinctDates: 2,               // evidence must span at least 2 dates
} as const;

export const PROMOTION_PROGRESS_WEIGHTS = {
  missions: 0.10,
  essentialTopics: 0.20,
  prerequisites: 0.15,
  objectiveAccuracy: 0.20,
  contextDiversity: 0.10,
  checkpoints: 0.10,
  consistency: 0.05,
  confidence: 0.10,
} as const;

// Maximum supported level — no promotion beyond this
export const MAX_SUPPORTED_PROMOTION_LEVEL: CEFRLevel = 'C1';

// Next level map
export const NEXT_LEVEL: Partial<Record<CEFRLevel, CEFRLevel>> = {
  A1: 'A2', A2: 'B1', B1: 'B2', B2: 'C1',
};
