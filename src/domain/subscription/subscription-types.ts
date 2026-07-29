/**
 * UI contracts for the subscription/paywall screen. src/hooks/useSubscriptionStatus.ts
 * adapts the real GET /api/subscription/status response (see
 * api/_entitlements/subscription-status-service.ts's SubscriptionStatusSnapshot)
 * into this shape. subscriptionProvider stays null until Apple/Google are
 * integrated — never populated client-side. subscription-mock-data.ts still
 * provides the DEV-only status switcher fixtures. Do not import these types
 * into enforcement code.
 */
export type SubscriptionAccessStatus = 'trialing' | 'active' | 'expired' | 'canceled' | 'billing_issue';

export interface SubscriptionScreenState {
  status: SubscriptionAccessStatus;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  currentPlanCode: string | null;
  currentPlanName: string | null;
  subscriptionProvider: 'apple' | 'google' | null;
  subscriptionExpiresAt: string | null;
}

export type CommercialPlanCode = 'essential' | 'plus';

export interface CommercialPlanDisplay {
  code: CommercialPlanCode;
  name: string;
  priceCents: number;
  writingPerDay: number;
  pronunciationPerDay: number;
  listeningPerDay: number;
  /** null = not yet defined for this plan. Never invent a number here — see SUBSCRIPTION_MESSAGES.conversationMinutesTbdDev. */
  conversationMinutesMonthly: number | null;
  allowsExtraMinutePackages: boolean;
}

export interface TrialDailyLimits {
  writingPerDay: number;
  pronunciationPerDay: number;
  listeningPerDay: number;
  conversationMinutesTotal: number;
}
