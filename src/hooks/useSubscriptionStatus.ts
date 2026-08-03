import { useEffect, useState } from 'react';
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
}

interface SubscriptionStatusResponse {
  status: SubscriptionScreenState['status'];
  accessType: SubscriptionScreenState['accessType'];
  planCode: string | null;
  planName: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  subscriptionExpiresAt: string | null;
  canManageSubscription: boolean;
  canRestorePurchases: boolean;
}

export function useSubscriptionStatus(): UseSubscriptionStatusResult {
  const [state, setState] = useState<SubscriptionScreenState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const headers = await getAuthHeader();
        const res = await fetch('/api/subscription/status', { headers });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as SubscriptionStatusResponse;
        if (cancelled) return;
        setState({
          status: data.status,
          accessType: data.accessType,
          trialEndsAt: data.trialEndsAt,
          trialDaysRemaining: data.trialDaysRemaining,
          currentPlanCode: data.planCode,
          currentPlanName: data.planName,
          // No payment provider integrated yet — never inferred client-side.
          subscriptionProvider: null,
          subscriptionExpiresAt: data.subscriptionExpiresAt,
          canManageSubscription: data.canManageSubscription,
          canRestorePurchases: data.canRestorePurchases,
        });
        setError(false);
      } catch {
        if (cancelled) return;
        setError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { state, error };
}
