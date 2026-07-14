import type { VocabularyLearningState, VocabularyEvidenceType, VocabularyProductionMode } from './vocabulary-types';
import type { VocabularyMasteryReasonCode } from './vocabulary-reason-codes';

export const CURRENT_SCHEDULING_VERSION = 'v1';

export interface SchedulingInput {
  currentState: VocabularyLearningState;
  stability: number;       // days (estimated days to 90% retention)
  difficulty: number;      // 0.0–1.0
  lapseCount: number;
  previousIntervalDays: number;
  evidenceType: VocabularyEvidenceType;
  productionMode: VocabularyProductionMode;
  evidenceWeight: number;
  occurredAt: string;
  schedulingVersion?: string;
  // Additional counters for state transitions
  successfulRecalls?: number;
  successfulUses?: number;
}

export interface SchedulingResult {
  newState: VocabularyLearningState;
  nextReviewAt: string | null;  // ISO string or null if mastered/maintenance
  intervalDays: number | null;
  newStability: number;
  newDifficulty: number;
  lapseIncrement: number;       // 0 or 1
  reasonCode: VocabularyMasteryReasonCode;
}

// SM-2 inspired constants
const INITIAL_STABILITY_INDEPENDENT = 4;  // days
const INITIAL_STABILITY_GUIDED = 2;
const INITIAL_STABILITY_ASSISTED = 1;
const MIN_STABILITY = 1;
const MAX_STABILITY = 365;
const LAPSE_STABILITY_MULTIPLIER = 0.2;  // lapse reduces stability to 20%
const EASE_FACTOR_BASE = 2.5;

// Calculate next review date
export function scheduleNextVocabularyReview(input: SchedulingInput): SchedulingResult {
  const {
    currentState,
    stability,
    difficulty,
    lapseCount,
    evidenceType,
    productionMode,
    evidenceWeight,
    occurredAt,
    successfulRecalls = 0,
    successfulUses = 0,
  } = input;

  // Lapse: retention_failure OR strongly negative weight in reviewing/mastered
  const isLapse =
    evidenceType === 'retention_failure' ||
    (evidenceWeight < -0.5 && (currentState === 'mastered' || currentState === 'maintenance'));

  if (isLapse) {
    const newStability = Math.max(MIN_STABILITY, stability * LAPSE_STABILITY_MULTIPLIER);
    const newDifficulty = Math.min(1.0, difficulty + 0.2);
    const intervalDays = 1;
    const lapseIncrement = 1;

    // State transition on lapse
    let newState: VocabularyLearningState;
    if (currentState === 'mastered' || currentState === 'maintenance') {
      newState = 'reviewing';
    } else if (currentState === 'reviewing') {
      newState = 'reviewing'; // stay
    } else if (currentState === 'learning' || currentState === 'introduced') {
      newState = 'learning';
    } else if (currentState === 'new') {
      newState = 'learning';
    } else {
      newState = currentState;
    }

    return {
      newState,
      nextReviewAt: addDays(occurredAt, intervalDays),
      intervalDays,
      newStability,
      newDifficulty,
      lapseIncrement,
      reasonCode: 'LAPSE_DETECTED',
    };
  }

  // Neutral / exposure / recognized — no schedule change
  if (
    evidenceType === 'exposure' ||
    evidenceType === 'recognized' ||
    evidenceWeight === 0
  ) {
    // Introduce item if new
    const newState: VocabularyLearningState = currentState === 'new' ? 'introduced' : currentState;
    const reasonCode: VocabularyMasteryReasonCode =
      currentState === 'new' ? 'ITEM_INTRODUCED' : 'SUCCESSFUL_RECALL';
    return {
      newState,
      nextReviewAt: null,
      intervalDays: null,
      newStability: stability,
      newDifficulty: difficulty,
      lapseIncrement: 0,
      reasonCode,
    };
  }

  // Partial use (medium weight)
  if (evidenceType === 'partial_use') {
    const newStability = stability; // slight reduction effectively via no improvement
    const intervalDays = Math.max(1, Math.round(stability * 0.7));
    const newState: VocabularyLearningState = currentState === 'new' ? 'introduced' : currentState;
    return {
      newState,
      nextReviewAt: addDays(occurredAt, intervalDays),
      intervalDays,
      newStability,
      newDifficulty: difficulty,
      lapseIncrement: 0,
      reasonCode: 'FIRST_VALID_USE',
    };
  }

  // Negative evidence (not lapse)
  if (evidenceWeight < 0) {
    const intervalDays = Math.max(1, Math.round(stability * 0.5));
    let newState: VocabularyLearningState = currentState;
    if (currentState === 'new') newState = 'introduced';

    const reasonCode: VocabularyMasteryReasonCode =
      evidenceType === 'meaning_error' ? 'MEANING_ERROR' :
      evidenceType === 'form_error' ? 'FORM_ERROR' :
      evidenceType === 'spelling_error' ? 'SPELLING_ERROR' :
      evidenceType === 'missed_required_item' ? 'REQUIRED_ITEM_MISSED' :
      'INCORRECT_USE';

    return {
      newState,
      nextReviewAt: addDays(occurredAt, intervalDays),
      intervalDays,
      newStability: Math.max(MIN_STABILITY, stability * 0.8),
      newDifficulty: Math.min(1.0, difficulty + 0.1),
      lapseIncrement: 0,
      reasonCode,
    };
  }

  // Positive evidence (recall, successful_use, valid_synonym, etc.)
  const isIndependent = productionMode === 'independent' || productionMode === 'unknown';
  const qualityBonus = isIndependent ? 0.1 : 0;
  const ease = Math.max(1.3, EASE_FACTOR_BASE - 0.8 * difficulty + qualityBonus);

  // Initialize stability if this is the first encounter
  let baseStability = stability;
  if (currentState === 'new' || currentState === 'introduced' || stability <= 1) {
    baseStability = computeInitialStability(productionMode);
  }

  const newStability = Math.min(MAX_STABILITY, baseStability * ease);
  const newDifficulty = Math.max(0, difficulty - 0.05);
  const intervalDays = Math.round(newStability);

  // State transitions on positive evidence
  let newState: VocabularyLearningState = currentState;
  let reasonCode: VocabularyMasteryReasonCode = 'SUCCESSFUL_RECALL';

  if (evidenceType === 'retention_success') {
    reasonCode = 'RETENTION_SUCCESS';
    if (currentState === 'maintenance') {
      newState = 'mastered';
    }
  } else if (evidenceType === 'recalled') {
    reasonCode = isIndependent ? 'SUCCESSFUL_RECALL' : 'SUCCESSFUL_GUIDED_USE';
    if (currentState === 'new') newState = 'introduced';
    else if (currentState === 'introduced') newState = 'learning';
  } else if (evidenceType === 'successful_use' || evidenceType === 'valid_synonym') {
    reasonCode = isIndependent ? 'SUCCESSFUL_INDEPENDENT_USE' : 'SUCCESSFUL_GUIDED_USE';
    if (evidenceType === 'valid_synonym') reasonCode = 'VALID_SYNONYM_USED';

    if (currentState === 'new') {
      newState = 'introduced';
    } else if (currentState === 'introduced') {
      newState = 'learning';
    } else if (currentState === 'learning') {
      // Need enough successes to advance to reviewing
      const totalSuccesses = successfulRecalls + successfulUses + 1; // +1 for this one
      if (totalSuccesses >= 3) {
        newState = 'reviewing';
      }
    } else if (currentState === 'reviewing') {
      // Need enough successes and no lapses to become mastered
      const totalSuccesses = successfulRecalls + successfulUses + 1;
      if (totalSuccesses >= 5 && lapseCount === 0) {
        newState = 'mastered';
        reasonCode = 'ITEM_MASTERED';
      }
    }
  } else if (evidenceType === 'copied_use') {
    reasonCode = 'ASSISTED_USE';
    if (currentState === 'new') newState = 'introduced';
  }

  const nextReviewAt = newState === 'mastered' ? null : addDays(occurredAt, intervalDays);

  return {
    newState,
    nextReviewAt,
    intervalDays,
    newStability,
    newDifficulty,
    lapseIncrement: 0,
    reasonCode,
  };
}

export function computeInitialStability(productionMode: VocabularyProductionMode): number {
  switch (productionMode) {
    case 'independent':
      return INITIAL_STABILITY_INDEPENDENT;
    case 'guided':
      return INITIAL_STABILITY_GUIDED;
    case 'assisted':
    case 'unknown':
    case 'system_generated':
    default:
      return INITIAL_STABILITY_ASSISTED;
  }
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}
