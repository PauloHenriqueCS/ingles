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
 * Fetches the authenticated user's plan entitlements once per mount. No
 * polling — screens call `refetch()` after an action that changes
 * consumption (mission generated, story started, evaluation completed,
 * conversation seconds used) to reconcile with the server.
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

  return { isLoading, data, error, refetch };
}
