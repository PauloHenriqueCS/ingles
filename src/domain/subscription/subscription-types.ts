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

/** Richer lifecycle state from the backend (see api/_entitlements/
 *  subscription-status-service.ts's SubscriptionLifecycleState) — layered on
 *  top of `status`. 'pending_downgrade' = active now, a lower plan scheduled
 *  for the next renewal (Google Play DEFERRED); 'not_renewing' = won't
 *  auto-renew with no known pending plan; 'cancelled_active' = a real
 *  cancellation, access until ends_at. */
export type SubscriptionLifecycleState =
  | 'trialing'
  | 'active'
  | 'cancelled_active'
  | 'pending_downgrade'
  | 'pending_upgrade'
  | 'not_renewing'
  | 'expired'
  | 'internal'
  | 'billing_issue';

/** Orthogonal to SubscriptionAccessStatus (never replaces it) — mirrors
 *  api/_entitlements/subscription-status-service.ts's SubscriptionAccessType.
 *  'internal' is the hand-assigned, non-commercial "Ilimitado" plan: no
 *  store, no billing, no renewal. 'commercial' is Essencial/Plus (or any
 *  future paid plan) — status can still be active/canceled/billing_issue
 *  within this type. */
export type SubscriptionAccessType = 'internal' | 'trial' | 'commercial' | 'none';

export interface SubscriptionScreenState {
  status: SubscriptionAccessStatus;
  /** Richer state from the backend — see SubscriptionLifecycleState. Optional
   *  so DEV mock fixtures (which only set `status`) stay valid; the selector
   *  falls back to `status` when it is absent. */
  subscriptionState?: SubscriptionLifecycleState;
  accessType: SubscriptionAccessType;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  currentPlanCode: string | null;
  currentPlanName: string | null;
  /** pending_downgrade/pending_upgrade only: the DB plan code (essencial/plus)
   *  scheduled for the next renewal, and when it takes effect. */
  pendingPlanCode?: string | null;
  pendingPlanName?: string | null;
  effectiveChangeAt?: string | null;
  subscriptionProvider: 'apple' | 'google' | null;
  subscriptionExpiresAt: string | null;
  /** Real store-management capability from the backend — never inferred
   *  from plan name or status on the frontend. Both false until a real
   *  store integration (RevenueCat) exists, for every access type. */
  canManageSubscription: boolean;
  canRestorePurchases: boolean;
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
