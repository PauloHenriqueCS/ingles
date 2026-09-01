/**
 * Streak-celebration EVENT detection — pure, weekday-aware, and idempotent BY
 * CONSTRUCTION (no persistence, no DB). Given the user's completed-day history
 * and their chosen practice weekdays, decide whether TODAY's completion is a
 * fixed milestone, a new personal record, both, or neither.
 *
 * Respects the practice-days routine: non-practice weekdays are skipped (never
 * break, never count), exactly like `computeWeekdayStreak`/`computeMaxWeekdayStreak`.
 *
 * Idempotency without storage:
 *   - MILESTONE fires only on the day the streak equals a milestone value — the
 *     streak passes through each value on exactly one day (it grows by 1 per
 *     practice day).
 *   - PERSONAL RECORD fires only on the day `current === previousBest + 1`, where
 *     `previousBest` is the longest streak among runs that have ALREADY ENDED
 *     (the current ongoing run is excluded, so it stays frozen while the run
 *     continues). Thus the crossing day is unique; a continuing run does not
 *     re-fire day after day.
 *
 * The provider still guards a once-per-São-Paulo-day window on top of this.
 */
import { computeWeekdayStreak, computeMaxWeekdayStreak } from './metricsCore';
import { getTodaySP } from './timezone';

/** Fixed milestones to celebrate (chosen: "mais frequentes"). Sorted ascending. */
export const STREAK_MILESTONES: readonly number[] = [
  3, 7, 14, 21, 30, 60, 90, 100, 180, 365, 730,
] as const;

/**
 * A personal record is only celebrated once the previous best was already
 * meaningful — avoids a silly "record" at 1–2 days or on the very first run.
 */
export const RECORD_MIN_PREVIOUS_BEST = 3;

export type StreakEventKind = 'milestone' | 'personal_record' | 'both';

export interface StreakEvent {
  /** Current consecutive-practice-day streak, including today. */
  current: number;
  /** Longest streak among runs that have already ended (excludes the ongoing run). */
  previousBest: number;
  isMilestone: boolean;
  isRecord: boolean;
  /** The celebration to show, or null when today is a plain day-complete. */
  kind: StreakEventKind | null;
}

/**
 * The active dates that make up the CURRENT ongoing streak run (the trailing
 * consecutive practice days up to today). Mirrors `computeWeekdayStreak`'s walk
 * so the two never disagree. Uses a noon anchor to avoid UTC date rollover.
 */
export function currentRunDates(
  activeDates: string[],
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
  todayOverride?: string,
): Set<string> {
  const run = new Set<string>();
  if (activeDates.length === 0) return run;

  const today = todayOverride ?? getTodaySP();
  const activeSet = new Set(activeDates);
  const cursor = new Date(today + 'T12:00:00');

  for (let guard = 0; guard < 400; guard++) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (dateStr > today) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    const dow = cursor.getDay();
    if (!activeWeekdays.includes(dow)) {
      cursor.setDate(cursor.getDate() - 1); // rest day: skip, don't break
      continue;
    }
    if (activeSet.has(dateStr)) {
      run.add(dateStr);
    } else if (dateStr === today) {
      // today not completed yet — don't break the run
    } else {
      break; // past practice day with no activity: run ended here
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return run;
}

/**
 * Detect the streak celebration for a day that JUST completed. Pure over the
 * given history + practice weekdays.
 */
export function detectStreakEvent(
  activeDates: string[],
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
  todayOverride?: string,
): StreakEvent {
  const current = computeWeekdayStreak(activeDates, todayOverride, activeWeekdays);

  // Previous best = the longest run EXCLUDING the current ongoing run. Removing
  // the ongoing run's dates leaves only ended runs, whose max is frozen while the
  // current run continues — that is what makes the record fire exactly once.
  const run = currentRunDates(activeDates, activeWeekdays, todayOverride);
  const priorDates = activeDates.filter((d) => !run.has(d));
  const previousBest = computeMaxWeekdayStreak(priorDates, activeWeekdays);

  const isMilestone = STREAK_MILESTONES.includes(current);
  const isRecord =
    current > 0 && current === previousBest + 1 && previousBest >= RECORD_MIN_PREVIOUS_BEST;

  const kind: StreakEventKind | null =
    isMilestone && isRecord
      ? 'both'
      : isRecord
        ? 'personal_record'
        : isMilestone
          ? 'milestone'
          : null;

  return { current, previousBest, isMilestone, isRecord, kind };
}
