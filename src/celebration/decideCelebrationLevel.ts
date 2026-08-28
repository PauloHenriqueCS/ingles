/**
 * Pure decision: given the obligatory activities the plan enabled, the
 * completed-today status (already forced to include the activity that just
 * finished), and which activity just finished — decide whether this completion
 * turned the whole day complete.
 *
 * This is the single rule that separates 'day-complete' from 'activity-complete'
 * and it mirrors `allActiveCompleted` in src/lib/dailyProgress exactly:
 *   day is complete ⇔ at least one obligatory activity is enabled AND every
 *   enabled obligatory activity is completed.
 *
 * Kept pure (no I/O, no React) so it is exhaustively unit-testable.
 */
import {
  type CelebrationActivityType,
  type ObligatoryCompletion,
  type ObligatoryFeatures,
  isObligatoryActivity,
} from './celebration-types';

export interface DecideInput {
  features: ObligatoryFeatures;
  /** Completed-today status; the just-finished activity MUST already be true. */
  completion: ObligatoryCompletion;
  justFinished: CelebrationActivityType;
}

export interface DecideResult {
  level: 'day-complete' | 'activity-complete';
  /** Obligatory practices done today (0 when nothing obligatory is enabled). */
  completedCount: number;
  /** Obligatory practices configured for today. */
  totalCount: number;
}

export function decideCelebrationLevel({
  features,
  completion,
  justFinished,
}: DecideInput): DecideResult {
  const enabled: boolean[] = [];
  const done: boolean[] = [];
  if (features.writing) {
    enabled.push(true);
    done.push(completion.writing);
  }
  if (features.pronunciation) {
    enabled.push(true);
    done.push(completion.pronunciation);
  }
  if (features.listening) {
    enabled.push(true);
    done.push(completion.listening);
  }

  const totalCount = enabled.length;
  const completedCount = done.filter(Boolean).length;

  // Conversation / review never complete a day on their own. And a day with no
  // obligatory activity enabled can never auto-complete (same as the calendar).
  const dayComplete =
    isObligatoryActivity(justFinished) &&
    totalCount > 0 &&
    done.every(Boolean);

  return {
    level: dayComplete ? 'day-complete' : 'activity-complete',
    completedCount,
    totalCount,
  };
}
