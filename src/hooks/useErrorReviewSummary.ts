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
 *
 * Refetches on mount AND when the app/tab regains visibility, for the same
 * reason as usePlanEntitlements: a Home that survives a background→foreground
 * round-trip after the user reviews some errors would otherwise keep showing the
 * pre-consumption count. Reconciling on visibility keeps the badge honest
 * without a relogin.
 */
export function useErrorReviewSummary(): ErrorReviewSummary {
  const [available, setAvailable] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refetchToken, setRefetchToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    fetchErrorReviewAvailableCount()
      .then((count) => { if (active) { setAvailable(count); setLoading(false); } })
      .catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
  }, [refetchToken]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const reconcileIfVisible = () => {
      if (document.visibilityState === 'visible') setRefetchToken((t) => t + 1);
    };
    document.addEventListener('visibilitychange', reconcileIfVisible);
    window.addEventListener('focus', reconcileIfVisible);
    return () => {
      document.removeEventListener('visibilitychange', reconcileIfVisible);
      window.removeEventListener('focus', reconcileIfVisible);
    };
  }, []);

  return { available, loading, error };
}
