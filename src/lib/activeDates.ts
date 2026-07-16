import { supabase } from './supabase';
import { toSpDate } from './timezone';
import { computeWeekdayStreak, computeMaxWeekdayStreak } from './metricsCore';

// Fetches every calendar date where the user completed at least one activity:
//   writing (english_reviews), pronunciation, conversation (goal met), listening.
//
// This is the single source of truth for "active day" used by streak and
// practiced-days counters across all screens.
export async function fetchAllActiveDates(): Promise<string[]> {
  const dates = new Set<string>();

  const [writingRes, pronunciationRes, listeningRes, sessionsRes, goalRes] =
    await Promise.all([
      supabase
        .from('english_reviews')
        .select('entry_date, created_at')
        .order('created_at', { ascending: false }),
      supabase
        .from('pronunciation_assessments')
        .select('completed_at')
        .eq('status', 'completed'),
      supabase
        .from('user_listening_assignments')
        .select('activity_date')
        .eq('status', 'completed'),
      supabase
        .from('conversation_sessions')
        .select('session_date, duration_sec'),
      supabase
        .from('ai_conversation_preferences')
        .select('daily_conversation_goal_minutes')
        .maybeSingle(),
    ]);

  // Writing: use entryDate when present, fall back to createdAt date.
  for (const row of writingRes.data ?? []) {
    const d =
      (row.entry_date as string | null) ??
      (row.created_at as string | null)?.slice(0, 10);
    if (d) dates.add(d);
  }

  // Pronunciation: convert UTC timestamp to São Paulo date.
  for (const row of pronunciationRes.data ?? []) {
    if (row.completed_at) dates.add(toSpDate(row.completed_at as string));
  }

  // Listening: activity_date is already a date string.
  for (const row of listeningRes.data ?? []) {
    if (row.activity_date) dates.add(row.activity_date as string);
  }

  // Conversation: sum duration per date, include date only when goal is met.
  const goalMin =
    ((goalRes.data as Record<string, unknown> | null)
      ?.daily_conversation_goal_minutes as number | undefined) ?? 15;
  const goalSec = goalMin * 60;
  const convByDate = new Map<string, number>();
  for (const row of sessionsRes.data ?? []) {
    const d = row.session_date as string | null;
    if (!d) continue;
    convByDate.set(d, (convByDate.get(d) ?? 0) + ((row.duration_sec as number) || 0));
  }
  for (const [d, total] of convByDate) {
    if (total >= goalSec) dates.add(d);
  }

  return Array.from(dates).sort();
}

// Convenience: fetch all active dates then compute the canonical streak.
export async function fetchCurrentStreak(
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
): Promise<number> {
  const dates = await fetchAllActiveDates();
  return computeWeekdayStreak(dates, undefined, activeWeekdays);
}

// Fetch both current and all-time max streak in a single DB round-trip.
export async function fetchStreaks(
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
): Promise<{ current: number; max: number }> {
  const dates = await fetchAllActiveDates();
  return {
    current: computeWeekdayStreak(dates, undefined, activeWeekdays),
    max: computeMaxWeekdayStreak(dates, activeWeekdays),
  };
}
