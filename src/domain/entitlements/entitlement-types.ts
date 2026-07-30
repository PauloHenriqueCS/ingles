/**
 * Shared (frontend + backend) types describing a user's resolved plan
 * entitlements for the four main student-facing activities. The backend
 * (api/_entitlements/plan-entitlements-service.ts) fills these in from the
 * plan/capability tables; the frontend renders them via computeFeatureState.
 */

export type FeatureAccessState =
  | 'available'
  | 'disabled_by_plan'
  | 'daily_limit_reached'
  | 'monthly_limit_reached'
  /** Etapa 2A — the internal 'trial' plan's lifetime total (period='lifetime')
   *  is exhausted. Distinct from monthly_limit_reached: a trial never
   *  resets on the calendar month, so the message must never say "mês". */
  | 'trial_balance_exhausted'
  | 'available_with_extra_credits'
  | 'unlimited'
  /** The plan version has some entitlements configured but is missing a
   *  required capability key — a configuration bug, not a business rule.
   *  Never surfaced to the user as "not included in your plan". */
  | 'config_error';

// 'lifetime' — Etapa 2A: the trial's total is consumed across the whole
// assignment window and never resets on a period boundary (see
// plan-entitlements-service.ts). Only ever set for conversation.monthlyTime
// when planCode === 'trial'.
export type LimitPeriod = 'day' | 'month' | 'request' | 'none' | 'lifetime';

export interface FeatureLimit {
  /** Whether the underlying activity is turned on for this plan at all. */
  enabled: boolean;
  /** True when the plan grants unlimited use — the sole source of truth for "Ilimitado". */
  unlimited: boolean;
  /** Configured limit for the period. Meaningless when unlimited is true. */
  limit: number;
  /** Confirmed consumption already counted for the current period. */
  consumed: number;
  /** max(limit - consumed, 0). Meaningless when unlimited is true. */
  remaining: number;
  period: LimitPeriod;
  state: FeatureAccessState;
  /** Whether starting a new instance of this action is currently allowed. */
  canStart: boolean;
}

export interface WritingEntitlements {
  enabled: boolean;
  themeGenerations: FeatureLimit;
  reviews: FeatureLimit;
  maxCharactersPerText: number;
  maxCharactersUnlimited: boolean;
}

export interface ListeningEntitlements {
  enabled: boolean;
  stories: FeatureLimit;
}

export interface PronunciationEntitlements {
  enabled: boolean;
  evaluations: FeatureLimit;
  maxRecordingSeconds: number;
  maxRecordingUnlimited: boolean;
}

export interface ConversationEntitlements {
  enabled: boolean;
  /** For the internal 'trial' plan (planCode === 'trial'), this holds the
   *  trial's lifetime total instead of a monthly one — period is 'lifetime',
   *  consumed is summed across the whole assignment window (see
   *  plan-entitlements-service.ts), and it never resets on a month change. */
  monthlyTime: FeatureLimit;
  maxRecordingSeconds: number;
  maxRecordingUnlimited: boolean;
  extraPurchaseEnabled: boolean;
  /** Sum of active, non-expired user_conversation_credits.remaining_seconds. */
  extraSecondsAvailable: number;
}

/** Etapa 2A — present on PlanEntitlementsSnapshot only when planCode==='trial'
 *  and resolved via a genuine user_plan_assignments row (never the
 *  default-plan fallback). Lets the conversation session route size an
 *  atomic, assignment-scoped authorization against the real trial window —
 *  see authorize-trial-conversation-session.ts. */
export interface ActiveTrialAssignment {
  id: string;
  startsAt: string;
  endsAt: string | null;
}

export interface PlanEntitlementsSnapshot {
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  planVersionId: string | null;
  suspended: boolean;
  writing: WritingEntitlements;
  listening: ListeningEntitlements;
  pronunciation: PronunciationEntitlements;
  conversation: ConversationEntitlements;
  /** Optional (absent is equivalent to null — every fixture/mock predating
   *  Etapa 2A that doesn't set this field simply has no active trial). */
  trialAssignment?: ActiveTrialAssignment | null;
  /** ISO timestamp when the monthly period (conversation) resets, if resolvable. Always null for the trial's lifetime total. */
  monthlyRenewsAt: string | null;
  resolvedAt: string;
}
