/**
 * SERVER-ONLY: atomic, concurrency-safe authorization of a NEW conversation
 * session for a user on a COMMERCIAL (monthly) plan — the commercial twin of
 * authorize-trial-conversation-session.ts.
 *
 * Wraps authorize_commercial_conversation_session_v1 (see the migration): under
 * a per-user advisory lock it reserves the FULL authorized_max_seconds of every
 * still-open row, so two sessions started at nearly the same instant can never
 * together be authorized for more than the real remaining monthly balance
 * (+ purchased extra credits). Closes the TOCTOU where the old commercial path
 * read canStart, minted the paid token, and only then inserted the row.
 *
 * The RPC re-derives the plan/limit/window server-side (never trusts a
 * caller-supplied value) and is service_role-only, so this MUST be called with a
 * service-role client. Only the already-authenticated userId and the requested
 * ceiling are trusted inputs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CommercialSessionAuthorizationParams {
  userId: string;
  requestedMaxSeconds: number;
  sessionDate: string;
  /** Effective monthly allowance in seconds, resolved server-side from
   *  entitlements (INCLUDING admin overrides). Trusted: this wrapper is only
   *  ever called with the service-role client from the route. */
  planLimitSeconds: number;
  planUnlimited: boolean;
  /** Purchased extra-minute credits still available (seconds), from entitlements. */
  extraCreditsSeconds: number;
  /** Client-generated (crypto.randomUUID()), stable across a network retry of
   *  the SAME /session attempt so a duplicate never reserves the balance twice. */
  idempotencyKey: string;
}

export interface CommercialSessionAuthorizationResult {
  authorizationId: string | null;
  authorizedMaxSeconds: number;
  blocked: boolean;
  /** 'no_active_plan' | 'monthly_limit_reached' | 'invalid_request' — logging only. */
  blockedReason: string | null;
}

interface AuthorizeCommercialSessionRow {
  authorization_id: string | null;
  authorized_max_seconds: number;
  blocked: boolean;
  blocked_reason: string | null;
}

export async function authorizeCommercialConversationSession(
  supabase: SupabaseClient,
  params: CommercialSessionAuthorizationParams,
): Promise<CommercialSessionAuthorizationResult> {
  const { data, error } = await supabase.rpc('authorize_commercial_conversation_session_v1', {
    p_user_id: params.userId,
    p_requested_max_seconds: Math.floor(params.requestedMaxSeconds),
    p_session_date: params.sessionDate,
    p_plan_limit_seconds: Math.max(0, Math.floor(params.planLimitSeconds)),
    p_plan_unlimited: params.planUnlimited,
    p_extra_credits_seconds: Math.max(0, Math.floor(params.extraCreditsSeconds)),
    p_idempotency_key: params.idempotencyKey,
  });
  if (error) throw new Error(`authorize_commercial_conversation_session_v1 failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as AuthorizeCommercialSessionRow | undefined;
  if (!row) return { authorizationId: null, authorizedMaxSeconds: 0, blocked: true, blockedReason: 'no_active_plan' };
  return {
    authorizationId: row.authorization_id,
    authorizedMaxSeconds: row.authorized_max_seconds,
    blocked: row.blocked,
    blockedReason: row.blocked_reason,
  };
}
