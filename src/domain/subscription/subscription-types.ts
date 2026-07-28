/**
 * UI-only contracts for the subscription/paywall screen. Deliberately
 * isolated from `../entitlements/*` — this screen does not read real plan
 * data yet, it only renders against a local mock (see subscription-mock-data.ts).
 * Do not import these types into enforcement code.
 */
export type SubscriptionAccessStatus = 'trialing' | 'active' | 'expired' | 'canceled';

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
