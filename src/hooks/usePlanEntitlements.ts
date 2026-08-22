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

  // Reconcile with the server when the app/tab becomes visible again. Only acts
  // on the transition INTO the foreground (visibilityState === 'visible'), so it
  // never fires while backgrounded and never storms the endpoint. A prior
  // in-flight request is aborted by the fetch effect above, so overlapping
  // refetches are safe.
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

  return { isLoading, data, error, refetch };
}
