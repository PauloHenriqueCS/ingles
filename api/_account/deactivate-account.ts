/**
 * SERVER-ONLY orchestrator for the self-service "Excluir minha conta" flow.
 * Called only from POST /api/account/deactivate (api/account/deactivate.ts)
 * after requireAuth has already resolved the caller's own userId from their
 * session — this never accepts a user_id from the request body.
 *
 * Order matters: every irreversible-from-the-user's-perspective step
 * (billing block, communication blocks, the deactivation row itself) is
 * created *before* this function reports success, so a caller can never
 * observe "deactivated" while the account could still be charged, still
 * receive a campaign, or still be usable on another still-open session
 * longer than strictly necessary. Session revocation happens last since it
 * cannot undo anything above it if it partially fails.
 */

import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { createDeactivation, getActiveDeactivation } from './deactivation-repository';
import { createAccountDeletionBillingBlock } from './billing-block-repository';
import { createAccountDeletionCommunicationBlocks } from './communication-suppression';
import { recordAccountAuditEvent } from './audit';

export interface DeactivateAccountResult {
  status: 'deactivated';
  alreadyDeactivated: boolean;
}

// GoTrue has no literal "forever" ban — only a duration string. ~100 years
// is the standard stand-in for "permanent" until an explicit, audited
// administrative reactivation clears it (see the migration's design note;
// reactivation is never automatic and never triggered by a new login).
const PERMANENT_BAN_DURATION = '876000h';

export async function deactivateAccount(params: {
  userId: string;
  accessToken: string;
  correlationId: string;
}): Promise<DeactivateAccountResult> {
  const { userId, accessToken, correlationId } = params;

  const existing = await getActiveDeactivation(userId);
  if (existing) {
    // Idempotent replay: already fully deactivated by a prior call. Re-assert
    // the blocks and re-issue session revocation — cheap (both are
    // idempotent themselves) and self-heals a partial failure from an
    // earlier attempt, without re-recording the one-time "deactivated" audit
    // event as if it were a fresh request.
    await recordAccountAuditEvent({
      userId,
      action: 'account.self_deactivation_requested',
      result: 'success',
      reason: 'idempotent_replay',
      correlationId,
    });
    await createAccountDeletionBillingBlock(userId);
    await createAccountDeletionCommunicationBlocks(userId);
    await revokeSessions(userId, accessToken, correlationId);
    return { status: 'deactivated', alreadyDeactivated: true };
  }

  await recordAccountAuditEvent({
    userId,
    action: 'account.self_deactivation_requested',
    result: 'success',
    correlationId,
  });

  await createAccountDeletionBillingBlock(userId);
  await recordAccountAuditEvent({ userId, action: 'account.billing_block_created', result: 'success', correlationId });

  await createAccountDeletionCommunicationBlocks(userId);
  await recordAccountAuditEvent({ userId, action: 'account.communication_blocks_created', result: 'success', correlationId });

  // No external subscription provider (Stripe, Apple App Store, Google
  // Play, RevenueCat, Mercado Pago) is integrated in this codebase — audited
  // before this flow was built. There is nothing to cancel; the billing
  // block above is what prevents any future internal charge or renewal, and
  // is itself checked by whatever checkout/subscription code is built next.
  await recordAccountAuditEvent({
    userId,
    action: 'account.external_subscription_check',
    result: 'success',
    reason: 'no_external_payment_provider_integrated',
    correlationId,
  });

  // Entitlements are revoked implicitly: requireAuth (api/_auth.ts) blocks
  // every authenticated route for a deactivated account before any
  // entitlement is even resolved, so there is no separate grant to revoke.
  await recordAccountAuditEvent({ userId, action: 'account.entitlements_revoked', result: 'success', correlationId });

  // No push-notification token table exists in this codebase today —
  // nothing to disable.
  await recordAccountAuditEvent({
    userId,
    action: 'account.push_tokens_disabled',
    result: 'success',
    reason: 'no_push_token_store',
    correlationId,
  });

  await createDeactivation(userId);
  await recordAccountAuditEvent({ userId, action: 'account.deactivated', result: 'success', correlationId });

  await revokeSessions(userId, accessToken, correlationId);

  return { status: 'deactivated', alreadyDeactivated: false };
}

async function revokeSessions(userId: string, accessToken: string, correlationId: string): Promise<void> {
  const supabase = getSharedServiceClient();

  // Blocks all FUTURE sign-ins and token refreshes for this user. An
  // already-issued access token remains valid until it expires on its own —
  // that gap is exactly why requireAuth's per-request ACCOUNT_DEACTIVATED
  // check (api/_account/deactivation-status.ts) is the real access control,
  // not this ban. A failure here is logged but does not undo the blocks and
  // deactivation flag already committed above, which remain fully effective
  // regardless of whether Supabase's own ban state agrees.
  const { error: banError } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: PERMANENT_BAN_DURATION,
  });
  await recordAccountAuditEvent({
    userId,
    action: 'account.ban_applied',
    result: banError ? 'failure' : 'success',
    errorCode: banError ? 'BAN_UPDATE_FAILED' : undefined,
    correlationId,
  });

  // Invalidates every refresh token tied to this user's session family — the
  // admin form of signOut with scope 'global', keyed off the caller's own
  // live access token (never another user's, since it came straight from
  // this same authenticated request).
  const { error: signOutError } = await supabase.auth.admin.signOut(accessToken, 'global');
  await recordAccountAuditEvent({
    userId,
    action: 'account.sessions_revoked',
    result: signOutError ? 'failure' : 'success',
    errorCode: signOutError ? 'SIGN_OUT_FAILED' : undefined,
    correlationId,
  });
}
