/**
 * SERVER-ONLY repository for public.user_billing_blocks. See migration
 * 20260723040001_create_user_billing_blocks.sql.
 *
 * No payment provider (Stripe, Apple App Store, Google Play, RevenueCat,
 * Mercado Pago, or any internal charging system) is integrated in this
 * codebase today — audited before that migration was written. This table
 * and assertBillingAllowed exist so that whenever checkout, subscription
 * creation/renewal, or a payment webhook is implemented, it has a single
 * ready-made gate to consult first — nothing else needs to change.
 */

import { getSharedServiceClient } from '../_ai-gateway/usage-repository';

export const ACCOUNT_DELETION_BILLING_REASON = 'user_requested_account_deletion';
export const ACCOUNT_DELETION_BILLING_SOURCE = 'account_deactivation';

export class BillingBlockedError extends Error {
  readonly code = 'BILLING_BLOCKED_ACCOUNT_DEACTIVATED';
  constructor(readonly reason: string) {
    super('Cobrança bloqueada: conta desativada.');
  }
}

/**
 * Idempotent — never creates a second active block for the same
 * user+reason (uq_user_billing_blocks_active_reason enforces this at the DB
 * level; the pre-check just avoids a noisy duplicate-key round trip).
 */
export async function createAccountDeletionBillingBlock(userId: string): Promise<void> {
  const supabase = getSharedServiceClient();

  const { data: existing, error: selectError } = await supabase
    .from('user_billing_blocks')
    .select('id')
    .eq('user_id', userId)
    .eq('reason', ACCOUNT_DELETION_BILLING_REASON)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error('Falha ao consultar bloqueio de cobrança.');
  if (existing) return;

  const { error } = await supabase.from('user_billing_blocks').insert({
    user_id: userId,
    reason: ACCOUNT_DELETION_BILLING_REASON,
    source: ACCOUNT_DELETION_BILLING_SOURCE,
    is_active: true,
  });
  if (error && (error as { code?: string }).code !== '23505') {
    throw new Error('Falha ao registrar bloqueio de cobrança.');
  }
}

/**
 * True when the user has any active billing block, for any reason. Fails
 * CLOSED on a lookup error (missing migration, transient DB error, etc.) —
 * unlike the account-deactivation read gate (which fails open so a
 * not-yet-applied migration never takes down every existing route), a
 * billing gate must never silently let a charge through on uncertainty.
 */
export async function isBillingBlocked(userId: string): Promise<boolean> {
  const supabase = getSharedServiceClient();
  const { data, error } = await supabase
    .from('user_billing_blocks')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (error) return true;
  return data != null;
}

/**
 * Every checkout, subscription-creation/renewal, plan-reactivation, and
 * payment-webhook handler must call this — before any charge attempt or
 * entitlement grant — and reject with BILLING_BLOCKED_ACCOUNT_DEACTIVATED
 * when it throws.
 */
export async function assertBillingAllowed(userId: string): Promise<void> {
  if (await isBillingBlocked(userId)) {
    throw new BillingBlockedError(ACCOUNT_DELETION_BILLING_REASON);
  }
}

// ── Subscription billing-issue signal ──────────────────────────────────────
//
// Reserved for a future payment-provider webhook (Apple/Google/Stripe — none
// integrated today, audited before this was written) to flag that a
// commercial plan's last renewal charge failed. Nothing in this codebase
// calls flagSubscriptionBillingIssue yet — it exists so the 'billing_issue'
// subscription state (api/_entitlements/subscription-status-service.ts) has
// a real, non-fake signal to read the moment billing is actually
// integrated, never a status invented client-side. Same table as the
// account-deletion block above, distinguished only by `reason` (free text,
// no CHECK constraint restricts it) — a billing issue and an
// account-deletion block are both, correctly, "cobrança bloqueada", so
// reusing the table is not a semantic stretch.

export const SUBSCRIPTION_BILLING_ISSUE_REASON = 'subscription_payment_failed';
export const SUBSCRIPTION_BILLING_ISSUE_SOURCE = 'subscription_billing';

/** Idempotent — never creates a second active billing-issue block for the same user. */
export async function flagSubscriptionBillingIssue(userId: string): Promise<void> {
  const supabase = getSharedServiceClient();

  const { data: existing, error: selectError } = await supabase
    .from('user_billing_blocks')
    .select('id')
    .eq('user_id', userId)
    .eq('reason', SUBSCRIPTION_BILLING_ISSUE_REASON)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (selectError) throw new Error('Falha ao consultar bloqueio de cobrança.');
  if (existing) return;

  const { error } = await supabase.from('user_billing_blocks').insert({
    user_id: userId,
    reason: SUBSCRIPTION_BILLING_ISSUE_REASON,
    source: SUBSCRIPTION_BILLING_ISSUE_SOURCE,
    is_active: true,
  });
  if (error && (error as { code?: string }).code !== '23505') {
    throw new Error('Falha ao registrar bloqueio de cobrança.');
  }
}

/** Lifts a previously flagged billing issue (e.g. a retried charge succeeded). */
export async function clearSubscriptionBillingIssue(userId: string, liftedBy: string): Promise<void> {
  const supabase = getSharedServiceClient();
  const { error } = await supabase
    .from('user_billing_blocks')
    .update({ is_active: false, lifted_at: new Date().toISOString(), lifted_by: liftedBy, lift_reason: 'resolved' })
    .eq('user_id', userId)
    .eq('reason', SUBSCRIPTION_BILLING_ISSUE_REASON)
    .eq('is_active', true);
  if (error) throw new Error('Falha ao liberar bloqueio de cobrança.');
}

/**
 * Read-only check used by the subscription status resolver to display
 * 'billing_issue' — never used to block a charge attempt (that remains
 * isBillingBlocked/assertBillingAllowed's job). Fails OPEN (false) on a
 * lookup error: unlike a billing gate, a transient read error here must
 * never falsely tell an otherwise-fine subscriber their payment failed.
 */
export async function hasActiveSubscriptionBillingIssue(userId: string): Promise<boolean> {
  const supabase = getSharedServiceClient();
  const { data, error } = await supabase
    .from('user_billing_blocks')
    .select('id')
    .eq('user_id', userId)
    .eq('reason', SUBSCRIPTION_BILLING_ISSUE_REASON)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return data != null;
}
