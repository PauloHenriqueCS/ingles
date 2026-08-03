import type { SubscriptionAccessStatus, SubscriptionScreenState } from './subscription-types';

/**
 * SINGLE mock data source for the subscription screen. Not connected to
 * Supabase or any real entitlements table — this is intentionally the only
 * place mock subscription state is defined, so it is trivial to delete once
 * a real data source (e.g. a hook reading plan_entitlements) replaces it.
 * Do not scatter ad-hoc mock objects into components.
 */
function daysFromNowIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export const MOCK_SUBSCRIPTION_STATES: Record<SubscriptionAccessStatus, SubscriptionScreenState> = {
  trialing: {
    status: 'trialing',
    accessType: 'trial',
    trialEndsAt: daysFromNowIso(4),
    trialDaysRemaining: 4,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    canManageSubscription: false,
    canRestorePurchases: false,
  },
  active: {
    status: 'active',
    accessType: 'commercial',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: 'essential',
    currentPlanName: 'Essencial',
    subscriptionProvider: 'apple',
    subscriptionExpiresAt: daysFromNowIso(18),
    // Hardcoded false for every mock, matching the real backend today (no
    // store integration yet) — see subscription-status-service.ts.
    canManageSubscription: false,
    canRestorePurchases: false,
  },
  expired: {
    status: 'expired',
    accessType: 'none',
    trialEndsAt: daysFromNowIso(-2),
    trialDaysRemaining: 0,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
    canManageSubscription: false,
    canRestorePurchases: false,
  },
  canceled: {
    status: 'canceled',
    accessType: 'commercial',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: 'plus',
    currentPlanName: 'Plus',
    subscriptionProvider: 'google',
    // Some providers keep access alive through the end of the paid period
    // after cancellation — still populated here so the screen can show it.
    subscriptionExpiresAt: daysFromNowIso(9),
    canManageSubscription: false,
    canRestorePurchases: false,
  },
  billing_issue: {
    status: 'billing_issue',
    accessType: 'commercial',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: 'essential',
    currentPlanName: 'Essencial',
    subscriptionProvider: 'apple',
    // Access typically survives until the period end even with a failed
    // charge — a grace window, same as 'canceled'.
    subscriptionExpiresAt: daysFromNowIso(3),
    canManageSubscription: false,
    canRestorePurchases: false,
  },
};

export const MOCK_STATUS_OPTIONS: SubscriptionAccessStatus[] = ['trialing', 'active', 'expired', 'canceled', 'billing_issue'];

/** Returns a fresh copy — callers (including placeholder button handlers)
 *  can never mutate the shared mock fixture through the returned object. */
export function getMockSubscriptionState(status: SubscriptionAccessStatus): SubscriptionScreenState {
  return { ...MOCK_SUBSCRIPTION_STATES[status] };
}
