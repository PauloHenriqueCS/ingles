import type { EnglishReviewSaved } from '../types';
import { getTodaySP } from './timezone';

// Returns the date when the user wrote the text (entryDate preferred over review creation date).
export function getPracticeDate(r: EnglishReviewSaved): string {
  return r.entryDate ?? r.createdAt.slice(0, 10);
}

// Deduplicate reviews so that each text (identified by entryDate) contributes only its
// most-recent evaluation to metrics. Reviews without entryDate are kept as-is.
//
// This prevents re-evaluations of the same text from inflating counts and averages.
export function deduplicateReviews(reviews: EnglishReviewSaved[]): EnglishReviewSaved[] {
  const byDate = new Map<string, EnglishReviewSaved>();
  const undated: EnglishReviewSaved[] = [];

  // Ascending so the last iteration (most recent createdAt) overwrites earlier ones per date.
  const sorted = [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const r of sorted) {
    if (r.entryDate) {
      byDate.set(r.entryDate, r);
    } else {
      undated.push(r);
    }
  }

  // Return sorted descending (most recent first) to match the convention used by callers.
  return [...byDate.values(), ...undated].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

// Canonical weekday-aware streak.
//
// Rules (per business spec):
//   - Only days in activeWeekdays (default Mon=1 … Fri=5) count as practice days.
//   - Weekend days are SKIPPED: they neither increment nor break the streak.
//   - If today is a weekday and has no activity yet, it doesn't break the streak
//     (gives the user the rest of the day).
//   - Any PAST weekday with no activity in activeDates breaks the streak.
//
// activeDates: YYYY-MM-DD strings for days with at least one completed activity.
export function computeWeekdayStreak(
  activeDates: string[],
  todayOverride?: string,
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
): number {
  if (activeDates.length === 0) return 0;

  const today = todayOverride ?? getTodaySP();
  const activeSet = new Set(activeDates);
  let streak = 0;

  // Walk backward from today. Guard at 400 to avoid infinite loops on bad input.
  const cursor = new Date(today + 'T12:00:00');
  for (let guard = 0; guard < 400; guard++) {
    const dateStr = cursor.toISOString().slice(0, 10);

    if (dateStr > today) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    const dow = cursor.getDay();
    if (!activeWeekdays.includes(dow)) {
      // Weekend: skip without breaking streak.
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    if (activeSet.has(dateStr)) {
      streak++;
    } else if (dateStr === today) {
      // Today hasn't been completed yet — don't break, give the user the day.
    } else {
      // Past weekday with no activity: streak is broken.
      break;
    }

    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}
