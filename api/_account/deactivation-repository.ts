/**
 * SERVER-ONLY repository for public.user_account_deactivations — the single
 * source of truth for "this account was deactivated by the user's own
 * request" (self-service account deletion). See migration
 * 20260723040000_create_user_account_deactivations.sql for the schema and
 * the reasoning for keeping this separate from user_access_controls.
 *
 * Every write here goes through the service-role client (RLS on this table
 * only allows admin-console reads/writes — see the migration) and never
 * accepts a user_id from anywhere but an already-authenticated session.
 */

import { getSharedServiceClient } from '../_ai-gateway/usage-repository';

export interface AccountDeactivationRow {
  id: string;
  userId: string;
  status: 'deactivated' | 'reactivated';
  reason: string;
  requestedAt: string;
  deactivatedAt: string;
}

function toRow(raw: any): AccountDeactivationRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    status: raw.status,
    reason: raw.reason,
    requestedAt: raw.requested_at,
    deactivatedAt: raw.deactivated_at,
  };
}

export async function getActiveDeactivation(userId: string): Promise<AccountDeactivationRow | null> {
  const supabase = getSharedServiceClient();
  const { data, error } = await supabase
    .from('user_account_deactivations')
    .select('id, user_id, status, reason, requested_at, deactivated_at')
    .eq('user_id', userId)
    .eq('status', 'deactivated')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Falha ao consultar o status da conta.');
  return data ? toRow(data) : null;
}

/**
 * Idempotent: if an active deactivation already exists for this user (a
 * retry, or a concurrent request that won the unique-index race), returns
 * it instead of erroring or inserting a second row —
 * uq_user_account_deactivations_active enforces "at most one active
 * deactivation per user" at the DB level regardless of what happens here.
 */
export async function createDeactivation(
  userId: string,
  reason = 'user_requested_account_deletion',
): Promise<AccountDeactivationRow> {
  const existing = await getActiveDeactivation(userId);
  if (existing) return existing;

  const supabase = getSharedServiceClient();
  const { data, error } = await supabase
    .from('user_account_deactivations')
    .insert({ user_id: userId, status: 'deactivated', reason })
    .select('id, user_id, status, reason, requested_at, deactivated_at')
    .single();

  if (error) {
    // 23505 = unique_violation: a concurrent request won the race between
    // our pre-check and this insert. Fetch and return the row it created
    // rather than failing a request that is, semantically, already done.
    if ((error as { code?: string }).code === '23505') {
      const winner = await getActiveDeactivation(userId);
      if (winner) return winner;
    }
    throw new Error('Falha ao registrar a exclusão da conta.');
  }
  return toRow(data);
}
