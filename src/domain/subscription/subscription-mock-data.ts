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
    trialEndsAt: daysFromNowIso(4),
    trialDaysRemaining: 4,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
  },
  active: {
    status: 'active',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: 'essential',
    currentPlanName: 'Essencial',
    subscriptionProvider: 'apple',
    subscriptionExpiresAt: daysFromNowIso(18),
  },
  expired: {
    status: 'expired',
    trialEndsAt: daysFromNowIso(-2),
    trialDaysRemaining: 0,
    currentPlanCode: null,
    currentPlanName: null,
    subscriptionProvider: null,
    subscriptionExpiresAt: null,
  },
  canceled: {
    status: 'canceled',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: 'plus',
    currentPlanName: 'Plus',
    subscriptionProvider: 'google',
    // Some providers keep access alive through the end of the paid period
    // after cancellation — still populated here so the screen can show it.
    subscriptionExpiresAt: daysFromNowIso(9),
  },
  billing_issue: {
    status: 'billing_issue',
    trialEndsAt: null,
    trialDaysRemaining: null,
    currentPlanCode: 'essential',
    currentPlanName: 'Essencial',
    subscriptionProvider: 'apple',
    // Access typically survives until the period end even with a failed
    // charge — a grace window, same as 'canceled'.
    subscriptionExpiresAt: daysFromNowIso(3),
  },
};

export const MOCK_STATUS_OPTIONS: SubscriptionAccessStatus[] = ['trialing', 'active', 'expired', 'canceled', 'billing_issue'];

/** Returns a fresh copy — callers (including placeholder button handlers)
 *  can never mutate the shared mock fixture through the returned object. */
export function getMockSubscriptionState(status: SubscriptionAccessStatus): SubscriptionScreenState {
  return { ...MOCK_SUBSCRIPTION_STATES[status] };
}
