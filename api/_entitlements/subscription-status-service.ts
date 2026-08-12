/**
 * SERVER-ONLY: resolves the authenticated user's SUBSCRIPTION-LEVEL status
 * (trialing / active / expired / canceled / billing_issue) for the
 * /assinatura screen. Never import from src/ or trust a status/plan sent by
 * the client — this is derived exclusively from the authenticated userId.
 *
 * This is a DISPLAY/LABELING layer, not a new access gate: per-feature
 * blocking (writing/listening/pronunciation/conversation) is already fully
 * handled by getCurrentUserPlanEntitlements
 * (api/_entitlements/plan-entitlements-service.ts), which reads the same
 * admin_resolve_effective_plan_v1 resolution and already fails closed for
 * every feature once a plan's capabilities say so — nothing here changes
 * that. This service only answers "which of the 5 states does the
 * subscription screen show, and since when/until when".
 *
 * State derivation (all server-side, from admin_resolve_effective_plan_v1 +
 * the resolved assignment row + the billing-issue flag):
 *   - 'trialing'      — plan_code === 'trial' AND a genuine (non-default-
 *                        fallback) assignment is currently in its window.
 *   - 'billing_issue' — a genuine non-trial assignment is active AND
 *                        hasActiveSubscriptionBillingIssue(userId) is true.
 *                        Checked before 'active'/'canceled' so a flagged
 *                        payment problem always wins the label.
 *   - 'canceled'      — a genuine non-trial assignment is active AND its
 *                        row has cancelled_at set. A graceful cancellation
 *                        NEVER changes user_plan_assignments.status away
 *                        from 'active' and never shortens ends_at below the
 *                        current period end — only cancelled_at/cancel_reason
 *                        are set — which is exactly what keeps
 *                        admin_resolve_effective_plan_v1 (and therefore
 *                        every feature gate) still returning this
 *                        assignment, satisfying "assinatura cancelada ainda
 *                        válida até o término". The write path for this
 *                        (an admin action, or in the future a store
 *                        cancellation webhook) is out of scope here — this
 *                        service only reads the resulting state.
 *   - 'active'        — a genuine non-trial assignment is active, no
 *                        billing issue, cancelled_at is null.
 *   - 'expired'       — everything else: resolved via the default-plan
 *                        fallback (no genuine assignment at all). Covers
 *                        both "trial ran out, no subscription" and "never
 *                        had one yet" (the latter should be rare once
 *                        grant_signup_trial_v1 is live) and "usuário sem
 *                        plano" (no default plan configured at all, plan_code
 *                        null) — there is no 6th state to distinguish these,
 *                        and all three correctly read as "no active
 *                        entitlement, show the plan picker".
 *
 * accessType — a SEPARATE, orthogonal classification added on top of
 * `status` (never replacing it) so the /assinatura screen can tell an
 * internal, hand-assigned, non-commercial plan apart from a real trial or a
 * real store subscription:
 *   - 'trial'      — status === 'trialing'.
 *   - 'none'       — status === 'expired' (the default-plan fallback; never
 *                    classified as internal or commercial — same
 *                    genuine-assignment principle the enforcement gate in
 *                    plan-entitlements-service.ts already uses).
 *   - 'internal'   — a genuine non-trial assignment to
 *                    INTERNAL_UNLIMITED_PLAN_CODE (plans.code = '24317180',
 *                    the hand-assigned "Ilimitado" plan: is_default=false,
 *                    is_visible_to_users=false, monthly_price_cents=0,
 *                    status='active' in homologation — identified by its
 *                    stable plan_code, never by matching the display name
 *                    "Ilimitado"). No store, no billing, no renewal — ever.
 *   - 'commercial' — any other genuine non-trial assignment (Essencial,
 *                    Plus, or any future paid plan). status can still be
 *                    'active'/'canceled'/'billing_issue' within this type.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { hasActiveSubscriptionBillingIssue } from '../_account/billing-block-repository';

export type SubscriptionStatus = 'trialing' | 'active' | 'expired' | 'canceled' | 'billing_issue';
export type SubscriptionAccessType = 'internal' | 'trial' | 'commercial' | 'none';

/**
 * Richer lifecycle state layered ON TOP of `status` (never replacing it) so the
 * screen can tell a scheduled plan change apart from a real cancellation:
 *   - 'pending_downgrade' — active, with a lower-tier plan scheduled for the
 *      next renewal (Google Play DEFERRED change). Access stays on the current
 *      (higher) plan until effectiveChangeAt.
 *   - 'pending_upgrade'   — active, with a higher-tier plan scheduled (rare;
 *      upgrades are immediate, so this is short-lived).
 *   - 'not_renewing'      — active but won't auto-renew, and NO pending plan is
 *      known (the honest fallback when unsubscribe_detected_at is set without a
 *      PRODUCT_CHANGE naming a target). Access until ends_at.
 *   - 'cancelled_active'  — a genuine CANCELLATION (cancelled_at set). Access
 *      until ends_at, then it lapses (no plan change).
 *   - 'active'            — active, auto-renewing, no pending change.
 * The legacy `status` still collapses the pending and not_renewing states to
 * 'active' and cancelled_active to 'canceled', so older clients stay
 * access-correct.
 */
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

/** Stable identifier of the hand-assigned, non-commercial "Ilimitado" plan —
 *  never match on plans.name, which is display text an admin could rename. */
export const INTERNAL_UNLIMITED_PLAN_CODE = '24317180';

export interface SubscriptionStatusSnapshot {
  status: SubscriptionStatus;
  /** Richer state layered on top of `status` — see SubscriptionLifecycleState. */
  subscriptionState: SubscriptionLifecycleState;
  accessType: SubscriptionAccessType;
  planCode: string | null;
  planName: string | null;
  /** pending_downgrade/pending_upgrade only: the plan scheduled to take effect
   *  at the next renewal, and when. Null when there is no scheduled change. */
  pendingPlanCode: string | null;
  pendingPlanName: string | null;
  effectiveChangeAt: string | null;
  /** False when the current subscription won't auto-renew (a real cancellation,
   *  a pending change, or a bare unsubscribe). True for trial/internal/expired
   *  and for a normally-renewing subscription. */
  autoRenew: boolean;
  /** trialing only. */
  trialEndsAt: string | null;
  /** trialing only — whole days remaining, floored at 0. */
  trialDaysRemaining: number | null;
  /** active/canceled/billing_issue: the current period's end (renewal date,
   *  or the date access ends after a graceful cancellation). Null otherwise.
   *  Always null for accessType 'internal' — there is no renewal. */
  subscriptionExpiresAt: string | null;
  /** Real store-management capability, not inferred from plan name or
   *  status. Hardcoded false for every accessType until a real store
   *  integration (RevenueCat) exists — never true for 'commercial' either,
   *  today. Wired so the screen can flip these on later without another
   *  contract change. */
  canManageSubscription: boolean;
  canRestorePurchases: boolean;
  resolvedAt: string;
}

/** Every branch below returns these two — hardcoded false, see the field
 *  doc comments on SubscriptionStatusSnapshot. */
const NO_STORE_CAPABILITIES_YET = { canManageSubscription: false, canRestorePurchases: false } as const;

interface EffectivePlanRow {
  access_allowed: boolean;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  assignment_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_suspended: boolean;
}

function daysRemaining(endsAtIso: string, now: Date): number {
  const ms = new Date(endsAtIso).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export async function resolveSubscriptionStatus(
  userId: string,
  deps?: { supabase?: SupabaseClient; now?: Date },
): Promise<SubscriptionStatusSnapshot> {
  const supabase = deps?.supabase ?? getSharedServiceClient();
  const now = deps?.now ?? new Date();
  const resolvedAt = now.toISOString();

  const { data: planRowsRaw, error } = await supabase.rpc('admin_resolve_effective_plan_v1', {
    p_user_id: userId,
    p_at: resolvedAt,
  });
  if (error) throw new Error(`admin_resolve_effective_plan_v1 failed: ${error.message}`);

  const plan = (Array.isArray(planRowsRaw) ? planRowsRaw[0] : planRowsRaw) as EffectivePlanRow | undefined;

  const expiredSnapshot = (): SubscriptionStatusSnapshot => ({
    status: 'expired',
    subscriptionState: 'expired',
    accessType: 'none',
    planCode: plan?.plan_code ?? null,
    planName: plan?.plan_name ?? null,
    pendingPlanCode: null,
    pendingPlanName: null,
    effectiveChangeAt: null,
    autoRenew: true,
    trialEndsAt: null,
    trialDaysRemaining: null,
    subscriptionExpiresAt: null,
    ...NO_STORE_CAPABILITIES_YET,
    resolvedAt,
  });

  if (!plan) return expiredSnapshot();

  // A genuine assignment (as opposed to the default-plan fallback, which
  // always returns assignment_id/starts_at = null — see
  // admin_resolve_effective_plan_v1's own contract, already relied on the
  // same way by plan-entitlements-service.ts's trialWindow).
  const hasRealAssignment = plan.assignment_id != null && plan.starts_at != null;

  if (plan.plan_code === 'trial' && hasRealAssignment) {
    const endsAt = plan.ends_at;
    return {
      status: 'trialing',
      subscriptionState: 'trialing',
      accessType: 'trial',
      planCode: plan.plan_code,
      planName: plan.plan_name,
      pendingPlanCode: null,
      pendingPlanName: null,
      effectiveChangeAt: null,
      autoRenew: true,
      trialEndsAt: endsAt,
      trialDaysRemaining: endsAt ? daysRemaining(endsAt, now) : null,
      subscriptionExpiresAt: null,
      ...NO_STORE_CAPABILITIES_YET,
      resolvedAt,
    };
  }

  if (hasRealAssignment) {
    // Never the default-plan fallback here (hasRealAssignment already
    // excludes it) — a genuine assignment to INTERNAL_UNLIMITED_PLAN_CODE is
    // the only thing that ever produces accessType 'internal'.
    const accessType: SubscriptionAccessType = plan.plan_code === INTERNAL_UNLIMITED_PLAN_CODE ? 'internal' : 'commercial';

    const [{ data: assignmentRow }, billingIssue] = await Promise.all([
      supabase
        .from('user_plan_assignments')
        .select('cancelled_at, auto_renew, pending_plan_id, pending_effective_at')
        .eq('id', plan.assignment_id as string)
        .maybeSingle(),
      hasActiveSubscriptionBillingIssue(userId),
    ]);

    if (billingIssue) {
      return {
        status: 'billing_issue',
        subscriptionState: 'billing_issue',
        accessType,
        planCode: plan.plan_code,
        planName: plan.plan_name,
        pendingPlanCode: null,
        pendingPlanName: null,
        effectiveChangeAt: null,
        autoRenew: false,
        trialEndsAt: null,
        trialDaysRemaining: null,
        subscriptionExpiresAt: plan.ends_at,
        ...NO_STORE_CAPABILITIES_YET,
        resolvedAt,
      };
    }

    // The internal (hand-assigned) unlimited plan has no store, billing,
    // renewal, cancellation, or pending change — ever.
    if (accessType === 'internal') {
      return {
        status: 'active',
        subscriptionState: 'internal',
        accessType,
        planCode: plan.plan_code,
        planName: plan.plan_name,
        pendingPlanCode: null,
        pendingPlanName: null,
        effectiveChangeAt: null,
        autoRenew: true,
        trialEndsAt: null,
        trialDaysRemaining: null,
        subscriptionExpiresAt: null,
        ...NO_STORE_CAPABILITIES_YET,
        resolvedAt,
      };
    }

    const row = assignmentRow as
      | { cancelled_at: string | null; auto_renew: boolean | null; pending_plan_id: string | null; pending_effective_at: string | null }
      | null;
    const cancelledAt = row?.cancelled_at ?? null;
    // auto_renew may be null on legacy rows written before the column existed —
    // treat null as "renewing" (the historical default), never as a problem.
    const autoRenew = row?.auto_renew !== false;
    const pendingPlanId = row?.pending_plan_id ?? null;
    // A DEFERRED change takes effect at the CURRENT period end. Use plan.ends_at
    // (the LIVE period end, kept fresh by every reconcile/renewal) as the
    // effective date — NOT the PRODUCT_CHANGE event's stored pending_effective_at,
    // which goes stale when the current subscription renews before the change
    // effects. The sandbox's compressed billing cycle made pending_effective_at
    // land in the past while Plus was still active, which wrongly collapsed
    // pending_downgrade to not_renewing. This assignment IS the effective plan
    // (admin_resolve_effective_plan_v1 returned it for `now`), so a
    // pending_plan_id here always means "scheduled, not yet effective" — no
    // separate future-date guard is needed.
    const pendingChangeAt = plan.ends_at ?? row?.pending_effective_at ?? null;

    let pendingPlanCode: string | null = null;
    let pendingPlanName: string | null = null;
    if (pendingPlanId) {
      const { data: pendingPlan } = await supabase
        .from('plans')
        .select('code, name')
        .eq('id', pendingPlanId)
        .maybeSingle();
      pendingPlanCode = (pendingPlan as { code: string | null } | null)?.code ?? null;
      pendingPlanName = (pendingPlan as { name: string | null } | null)?.name ?? null;
    }
    const hasPendingChange = pendingPlanCode != null;

    // Rank pending vs current by known tier order (essencial < plus). Unknown
    // codes → treat as a plain "pending change" (defaults to downgrade wording,
    // the safer, more common case) rather than guessing an upgrade.
    const TIER_RANK: Record<string, number> = { essencial: 1, plus: 2 };
    const currentRank = plan.plan_code ? TIER_RANK[plan.plan_code] ?? 0 : 0;
    const pendingRank = pendingPlanCode ? TIER_RANK[pendingPlanCode] ?? 0 : 0;

    let subscriptionState: SubscriptionLifecycleState;
    if (hasPendingChange) {
      subscriptionState = pendingRank > currentRank ? 'pending_upgrade' : 'pending_downgrade';
    } else if (cancelledAt) {
      subscriptionState = 'cancelled_active';
    } else if (!autoRenew) {
      subscriptionState = 'not_renewing';
    } else {
      subscriptionState = 'active';
    }

    return {
      // Legacy status stays access-correct: a genuine cancellation reads
      // 'canceled'; a pending change or not-renewing subscription is still
      // 'active' (the user has full access to the current plan).
      status: cancelledAt && !hasPendingChange ? 'canceled' : 'active',
      subscriptionState,
      accessType,
      planCode: plan.plan_code,
      planName: plan.plan_name,
      pendingPlanCode,
      pendingPlanName,
      effectiveChangeAt: hasPendingChange ? pendingChangeAt : null,
      autoRenew,
      trialEndsAt: null,
      trialDaysRemaining: null,
      subscriptionExpiresAt: plan.ends_at,
      ...NO_STORE_CAPABILITIES_YET,
      resolvedAt,
    };
  }

  return expiredSnapshot();
}
