import { useEffect, useState } from 'react';
import { fetchErrorReviewAvailableCount } from '../lib/errorReview';

interface ErrorReviewSummary {
  available: number | null;
  loading: boolean;
  error: boolean;
}

/**
 * Lightweight summary for the Home "Revisar meus erros" card — how many
 * exercises are available today (already capped at the daily limit server-side).
 * Loading/error resolve to a neutral card that stays navigable; the activity
 * screen itself owns the real loading/empty/error states.
 */
export function useErrorReviewSummary(): ErrorReviewSummary {
  const [available, setAvailable] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    fetchErrorReviewAvailableCount()
      .then((count) => { if (active) { setAvailable(count); setLoading(false); } })
      .catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
  }, []);

  return { available, loading, error };
}
