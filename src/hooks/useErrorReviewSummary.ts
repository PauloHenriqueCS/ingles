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

  // Same dual web + native-resume reconcile as usePlanEntitlements: on a
  // Capacitor WebView `visibilitychange` is unreliable on app resume, so the App
  // plugin's `appStateChange` (isActive) is needed to refresh a Home that
  // survived a background→foreground round-trip.
  useEffect(() => {
    const reconcile = () => setRefetchToken((t) => t + 1);

    const onVisible = () => { if (document.visibilityState === 'visible') reconcile(); };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
    }

    let removeAppListener: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) reconcile();
        });
        if (cancelled) { void handle.remove(); } else { removeAppListener = () => { void handle.remove(); }; }
      } catch { /* plugin unavailable — DOM events suffice */ }
    })();

    return () => {
      cancelled = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
      }
      if (removeAppListener) removeAppListener();
    };
  }, []);

  return { available, loading, error };
}
