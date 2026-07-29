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
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { hasActiveSubscriptionBillingIssue } from '../_account/billing-block-repository';

export type SubscriptionStatus = 'trialing' | 'active' | 'expired' | 'canceled' | 'billing_issue';

export interface SubscriptionStatusSnapshot {
  status: SubscriptionStatus;
  planCode: string | null;
  planName: string | null;
  /** trialing only. */
  trialEndsAt: string | null;
  /** trialing only — whole days remaining, floored at 0. */
  trialDaysRemaining: number | null;
  /** active/canceled/billing_issue: the current period's end (renewal date,
   *  or the date access ends after a graceful cancellation). Null otherwise. */
  subscriptionExpiresAt: string | null;
  resolvedAt: string;
}

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
    planCode: plan?.plan_code ?? null,
    planName: plan?.plan_name ?? null,
    trialEndsAt: null,
    trialDaysRemaining: null,
    subscriptionExpiresAt: null,
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
      planCode: plan.plan_code,
      planName: plan.plan_name,
      trialEndsAt: endsAt,
      trialDaysRemaining: endsAt ? daysRemaining(endsAt, now) : null,
      subscriptionExpiresAt: null,
      resolvedAt,
    };
  }

  if (hasRealAssignment) {
    const [{ data: assignmentRow }, billingIssue] = await Promise.all([
      supabase
        .from('user_plan_assignments')
        .select('cancelled_at')
        .eq('id', plan.assignment_id as string)
        .maybeSingle(),
      hasActiveSubscriptionBillingIssue(userId),
    ]);

    if (billingIssue) {
      return {
        status: 'billing_issue',
        planCode: plan.plan_code,
        planName: plan.plan_name,
        trialEndsAt: null,
        trialDaysRemaining: null,
        subscriptionExpiresAt: plan.ends_at,
        resolvedAt,
      };
    }

    const cancelledAt = (assignmentRow as { cancelled_at: string | null } | null)?.cancelled_at ?? null;
    return {
      status: cancelledAt ? 'canceled' : 'active',
      planCode: plan.plan_code,
      planName: plan.plan_name,
      trialEndsAt: null,
      trialDaysRemaining: null,
      subscriptionExpiresAt: plan.ends_at,
      resolvedAt,
    };
  }

  return expiredSnapshot();
}
