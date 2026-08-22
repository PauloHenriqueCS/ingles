import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPlanEntitlements } from '../lib/planEntitlementsFetcher';
import type { PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

export interface PlanEntitlementsState {
  isLoading: boolean;
  data: PlanEntitlementsSnapshot | null;
  error: string | null;
  /** Re-fetches from the server — call after any action that changes consumption. */
  refetch: () => void;
}

/**
 * Fetches the authenticated user's plan entitlements once per mount AND
 * whenever the app/tab regains visibility (resume from background, tab
 * refocus). Screens may also call `refetch()` explicitly after an action that
 * changes consumption (mission generated, story started, evaluation completed,
 * conversation seconds used).
 *
 * The visibility refetch is the single source of truth for freshness: a screen
 * that stays mounted while the user consumes quota elsewhere — most commonly a
 * mobile WebView Home that survives a background→foreground round-trip after the
 * user practises a Listening/Writing/Pronúncia — would otherwise keep rendering
 * the pre-consumption snapshot and show e.g. "1 restante" after the daily limit
 * is already reached. Reconciling on visibility guarantees the Home badge always
 * reflects the SAME server-resolved eligibility the activity gate enforces,
 * without a relogin or a manual pull-to-refresh. It never changes any limit —
 * it only re-reads the authoritative snapshot.
 */
export function usePlanEntitlements(): PlanEntitlementsState {
  const [data, setData] = useState<PlanEntitlementsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    fetchPlanEntitlements(controller.signal)
      .then((snapshot) => {
        setData(snapshot);
        setIsLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setError(err.message);
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [refetchToken]);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  // Reconcile with the server when the app/tab becomes active again. A prior
  // in-flight request is aborted by the fetch effect above, so overlapping
  // refetches are safe.
  //
  // Two signals, because neither alone is enough on every platform:
  //  - Web/PWA: `visibilitychange`/`focus` fire on tab show/refocus.
  //  - Native (Capacitor Android/iOS WebView): the WebView does NOT reliably
  //    emit `visibilitychange` on app resume, so a Home that survived a
  //    background→foreground round-trip would keep its pre-consumption snapshot
  //    (e.g. "1 restante" after the daily limit is already reached). The App
  //    plugin's `appStateChange` (isActive === true) is the reliable resume
  //    signal there — same plugin the realtime session uses. Best-effort: on web
  //    the dynamic import may resolve to a no-op, which the DOM events cover.
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

  return { isLoading, data, error, refetch };
}
