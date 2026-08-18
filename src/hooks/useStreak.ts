import { useEffect, useState } from 'react';
import { fetchCurrentStreak } from '../lib/activeDates';

interface StreakState {
  /** Consecutive practice days ending today (São Paulo). 0 = no streak yet. */
  streak: number | null;
  loading: boolean;
  error: boolean;
}

/**
 * Current consecutive-days practice streak for the Home streak card. Reuses the
 * canonical streak calculator (activeDates.fetchCurrentStreak →
 * computeWeekdayStreak) so the Home value can never diverge from the Dashboard's
 * "Sequência" chip. A day counts when the user completed at least one valid
 * activity (writing, pronunciation, listening, conversation goal-met, or an
 * error-review submission). Loading/error resolve to a neutral card that still
 * renders (0 days), never a fabricated number.
 *
 * activeWeekdays comes from the user's learning settings so planned rest days
 * (e.g. weekends on a Mon–Fri plan) neither break nor extend the streak —
 * identical to the calendar rule.
 */
export function useStreak(activeWeekdays: number[]): StreakState {
  const [streak, setStreak] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Stringified so a new array identity with the same weekdays doesn't refetch.
  const key = activeWeekdays.join(',');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    fetchCurrentStreak(activeWeekdays)
      .then((n) => { if (active) { setStreak(n); setLoading(false); } })
      .catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { streak, loading, error };
}
