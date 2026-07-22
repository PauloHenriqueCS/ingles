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
