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
  | 'available_with_extra_credits'
  | 'unlimited';

export type LimitPeriod = 'day' | 'month' | 'request' | 'none';

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
  monthlyTime: FeatureLimit;
  maxRecordingSeconds: number;
  maxRecordingUnlimited: boolean;
  extraPurchaseEnabled: boolean;
  /** Sum of active, non-expired user_conversation_credits.remaining_seconds. */
  extraSecondsAvailable: number;
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
  /** ISO timestamp when the monthly period (conversation) resets, if resolvable. */
  monthlyRenewsAt: string | null;
  resolvedAt: string;
}
