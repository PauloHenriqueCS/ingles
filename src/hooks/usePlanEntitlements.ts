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
 * Fetches the authenticated user's plan entitlements and keeps them fresh with a
 * stale-while-revalidate strategy:
 *
 *  - The `loading` state is entered ONLY on the very first load (when there is no
 *    snapshot yet). Every later revalidation runs in the background and KEEPS the
 *    previous snapshot on screen. This is the critical difference from a naive
 *    refetch: `HomePage` renders `resolved = isLoading ? null : entitlements`, so
 *    flipping `isLoading` true on a refetch would blank every card to a loading
 *    state (icons grey, no "X restante" badge) each time — that regression is why
 *    an earlier version was reverted. Here a refetch never blanks the Home.
 *  - A FAILED revalidation never clears `data` — the last good snapshot stays
 *    visible (a transient network/auth blip must not wipe the Home).
 *  - It revalidates automatically when the app/tab returns to the foreground
 *    (web `visibilitychange`/`focus` AND the Capacitor `appStateChange` resume
 *    signal, which is the reliable one inside the native WebView). This is what
 *    reconciles a Home that stayed mounted while the user consumed quota
 *    elsewhere — e.g. finishing the last Listening then returning: the badge
 *    updates from "1 restante" to "Limite de hoje" without a manual reload.
 *
 * Screens may still call `refetch()` explicitly right after an action that
 * changes consumption.
 */
export function usePlanEntitlements(): PlanEntitlementsState {
  const [data, setData] = useState<PlanEntitlementsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  // True once the first successful load has populated `data`. After that, no
  // refetch is ever allowed to flip back into the blanking `loading` state.
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    // First load → show loading. Background revalidation → keep showing the
    // previous snapshot (stale-while-revalidate), never blank the cards.
    if (!hasLoadedRef.current) setIsLoading(true);
    setError(null);

    fetchPlanEntitlements(controller.signal)
      .then((snapshot) => {
        hasLoadedRef.current = true;
        setData(snapshot);
        setIsLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setError(err.message);
        setIsLoading(false);
        // Deliberately NOT clearing `data`: a failed revalidation keeps the last
        // good snapshot on screen instead of wiping the Home to a blank state.
      });

    return () => controller.abort();
  }, [refetchToken]);

  const refetch = useCallback(() => setRefetchToken((t) => t + 1), []);

  // Revalidate when the app/tab regains the foreground. A prior in-flight request
  // is aborted by the fetch effect above, so overlapping refetches are safe.
  // Two signals because neither alone covers every platform:
  //  - Web/PWA: `visibilitychange`/`focus`.
  //  - Native (Capacitor WebView): `visibilitychange` is unreliable on resume, so
  //    the App plugin's `appStateChange` (isActive) is the reliable trigger.
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
      } catch { /* plugin unavailable (web) — DOM events suffice */ }
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
