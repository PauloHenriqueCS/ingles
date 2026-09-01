/**
 * Global activity-completion celebration system — shared types.
 *
 * A celebration is a short, full-screen reward shown ONCE, right after a real,
 * server-confirmed activity completion (a genuine not-completed → completed
 * transition). There are exactly two levels:
 *
 *   - 'activity-complete' — one activity finished, but the day is not yet done.
 *   - 'day-complete'      — this completion finished ALL obligatory practices
 *                           configured for today (writing/pronunciation/
 *                           listening that the plan has enabled). When a day
 *                           completes we show ONLY the day-complete celebration,
 *                           never the individual one first.
 *
 * The obligatory set mirrors the calendar's own rule (see src/lib/dailyProgress
 * `computeDailyProgress` / `allActiveCompleted`): conversation and error-review
 * are always optional and can never, on their own, complete a day.
 */

/** The activities that can be celebrated. Mirrors the AppsFlyer analytics union. */
export type CelebrationActivityType =
  | 'writing'
  | 'listening'
  | 'pronunciation'
  | 'conversation'
  | 'review';

/**
 * The three activities that count toward "the day is done". Conversation and
 * review are deliberately excluded — identical to `ActiveDailyFeatures` in
 * src/lib/dailyProgress.
 */
export type ObligatoryActivityType = 'writing' | 'listening' | 'pronunciation';

export const OBLIGATORY_ACTIVITIES: readonly ObligatoryActivityType[] = [
  'writing',
  'pronunciation',
  'listening',
] as const;

export function isObligatoryActivity(
  a: CelebrationActivityType,
): a is ObligatoryActivityType {
  return a === 'writing' || a === 'pronunciation' || a === 'listening';
}

/** Which streak celebration to show (see src/lib/streakEvents.ts). */
export type StreakCelebrationKind = 'milestone' | 'personal_record' | 'both';

/** The celebration payloads that drive the overlay. */
export type Celebration =
  | {
      type: 'activity-complete';
      activityType: CelebrationActivityType;
      /** How many obligatory practices are done today (incl. this one). */
      completedCount?: number;
      /** How many obligatory practices are configured for today. */
      totalCount?: number;
    }
  | {
      type: 'day-complete';
      /** Consecutive-days streak ending today, when reliably available. */
      streakDays?: number | null;
      completedCount?: number;
      totalCount?: number;
    }
  | {
      /**
       * A streak milestone and/or a new personal record. Shown INSTEAD of the
       * plain day-complete on the day it happens (it also completes the day).
       */
      type: 'streak';
      kind: StreakCelebrationKind;
      /** Current consecutive-practice-day streak, including today. */
      streakDays: number;
      /** Previous personal best (used in record/both copy). */
      previousBest: number;
      completedCount?: number;
      totalCount?: number;
    };

/** Which of the three obligatory activities the user's plan has turned on. */
export interface ObligatoryFeatures {
  writing: boolean;
  pronunciation: boolean;
  listening: boolean;
}

/** Completed-today status for each obligatory activity (mirrors the calendar). */
export interface ObligatoryCompletion {
  writing: boolean;
  pronunciation: boolean;
  listening: boolean;
}
