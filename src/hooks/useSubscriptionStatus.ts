import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthHeader } from '../lib/apiAuth';
import type { SubscriptionScreenState } from '../domain/subscription/subscription-types';

/**
 * Real data source for the /assinatura screen — fetches GET
 * /api/subscription/status (see api/_entitlements/subscription-status-service.ts)
 * and adapts its response into SubscriptionScreenState. The server derives
 * status/plan/dates entirely from the authenticated session; nothing here
 * sends or overrides a plan/status.
 */
export interface UseSubscriptionStatusResult {
  state: SubscriptionScreenState | null;
  error: boolean;
  /** Re-fetches. sync=true calls POST /api/subscription/sync instead (same
   *  response shape — api/_billing/subscription-sync-route-handler.ts —
   *  proactively reconciles with RevenueCat first) — call this right after
   *  a native purchase/restore, before the webhook necessarily arrives. */
  refetch: (options?: { sync?: boolean }) => Promise<void>;
}

interface SubscriptionStatusResponse {
  status: SubscriptionScreenState['status'];
  subscriptionState?: SubscriptionScreenState['subscriptionState'];
  accessType: SubscriptionScreenState['accessType'];
  planCode: string | null;
  planName: string | null;
  pendingPlanCode?: string | null;
  pendingPlanName?: string | null;
  effectiveChangeAt?: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  subscriptionExpiresAt: string | null;
  canManageSubscription: boolean;
  canRestorePurchases: boolean;
}

function toScreenState(data: SubscriptionStatusResponse): SubscriptionScreenState {
  return {
    status: data.status,
    subscriptionState: data.subscriptionState,
    accessType: data.accessType,
    trialEndsAt: data.trialEndsAt,
    trialDaysRemaining: data.trialDaysRemaining,
    currentPlanCode: data.planCode,
    currentPlanName: data.planName,
    pendingPlanCode: data.pendingPlanCode ?? null,
    pendingPlanName: data.pendingPlanName ?? null,
    effectiveChangeAt: data.effectiveChangeAt ?? null,
    // No payment provider integrated yet — never inferred client-side.
    subscriptionProvider: null,
    subscriptionExpiresAt: data.subscriptionExpiresAt,
    canManageSubscription: data.canManageSubscription,
    canRestorePurchases: data.canRestorePurchases,
  };
}

export function useSubscriptionStatus(): UseSubscriptionStatusResult {
  const [state, setState] = useState<SubscriptionScreenState | null>(null);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refetch = useCallback(async (options?: { sync?: boolean }) => {
    try {
      const headers = await getAuthHeader();
      const res = options?.sync
        ? await fetch('/api/subscription/sync', { method: 'POST', headers })
        : await fetch('/api/subscription/status', { headers });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as SubscriptionStatusResponse;
      if (!mountedRef.current) return;
      setState(toScreenState(data));
      setError(false);
    } catch {
      if (!mountedRef.current) return;
      setError(true);
    }
  }, []);

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, error, refetch };
}
