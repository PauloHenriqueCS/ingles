/**
 * SERVER-ONLY: writes account-deactivation events to the existing
 * public.admin_audit_log table rather than introducing a parallel audit
 * table. That table is normally written by admin-console actions
 * (actor_role/permission_key/admin_session_id populated) — for a
 * self-service action those admin-only columns are left null and
 * actor_user_id is the user acting on their own account. target_type is a
 * stable 'user_account' so this trail can be filtered independently of the
 * admin console's own action taxonomy.
 *
 * Never logs tokens, secrets, card data, or raw email/phone — only
 * identifiers and safe result codes. Never throws: an audit failure must
 * never abort or fail the deactivation operation itself.
 */

import { getSharedServiceClient } from '../_ai-gateway/usage-repository';

export type AccountAuditAction =
  | 'account.self_deactivation_requested'
  | 'account.billing_block_created'
  | 'account.communication_blocks_created'
  | 'account.external_subscription_check'
  | 'account.entitlements_revoked'
  | 'account.push_tokens_disabled'
  | 'account.deactivated'
  | 'account.sessions_revoked'
  | 'account.ban_applied';

export interface AccountAuditParams {
  userId: string;
  action: AccountAuditAction;
  result: 'success' | 'failure';
  reason?: string;
  errorCode?: string;
  afterState?: Record<string, unknown>;
  correlationId?: string;
}

export async function recordAccountAuditEvent(params: AccountAuditParams): Promise<void> {
  try {
    const supabase = getSharedServiceClient();
    await supabase.from('admin_audit_log').insert({
      actor_user_id: params.userId,
      action: params.action,
      target_type: 'user_account',
      target_id: params.userId,
      reason: params.reason ?? null,
      result: params.result,
      error_code: params.errorCode ?? null,
      after_state: params.afterState ?? null,
      correlation_id: params.correlationId ?? null,
      environment: 'app',
    });
  } catch {
    // Never let an audit-log failure break the deactivation flow.
  }
}
