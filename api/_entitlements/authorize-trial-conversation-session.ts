/**
 * SERVER-ONLY: atomic, concurrency-safe authorization of a NEW conversation
 * session for a user on the internal 'trial' plan.
 *
 * Wraps authorize_trial_conversation_session_v1 (see
 * supabase/migrations/20260727224200_authorize_trial_conversation_session.sql)
 * — the minimal extension needed because the trial's 900s total is a
 * lifetime (never-renewed) budget: two sessions requested at nearly the
 * same instant must never, together, authorize more than the real remaining
 * balance. Commercial plans keep using the existing plain INSERT in
 * api/conversation/[...slug].ts, completely unchanged.
 *
 * Security note (Etapa 2A revision): this function intentionally does NOT
 * accept an assignmentId, window, or trialTotalSeconds — earlier revisions
 * did, trusting values computed in TypeScript. The RPC now re-derives the
 * user's effective plan/assignment/trial_total itself (via
 * admin_resolve_effective_plan_v1 + plan_capability_values), so a bug here
 * can request a duration but can never fabricate a plan, a window, or a
 * balance. Only userId (the already-authenticated caller) and the requested
 * ceiling are trusted inputs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface TrialSessionAuthorizationParams {
  userId: string;
  requestedMaxSeconds: number;
  sessionDate: string;
  gatewayBudgetReservationId: string | null;
  gatewaySessionId: string | null;
  /** Client-generated (crypto.randomUUID(), same pattern as
   *  PronunciationRecorder.tsx/ListeningView.tsx's attemptId/submissionId) —
   *  stable across a network-level retry of the SAME /session attempt, so a
   *  duplicate call never reserves the trial balance twice. See the
   *  migration's header comment for why conversation_session_authorizations
   *  otherwise has no idempotency key at all. */
  idempotencyKey: string;
}

export interface TrialSessionAuthorizationResult {
  authorizationId: string | null;
  authorizedMaxSeconds: number;
  blocked: boolean;
  /** Present only when blocked=true — 'no_active_trial' (no genuine trial
   *  assignment, wrong plan, or missing capability config),
   *  'balance_exhausted', or 'invalid_request' (non-positive requested
   *  seconds). Never surfaced to the end user verbatim — for logging only. */
  blockedReason: string | null;
}

interface AuthorizeTrialSessionRow {
  authorization_id: string | null;
  authorized_max_seconds: number;
  blocked: boolean;
  blocked_reason: string | null;
}

export async function authorizeTrialConversationSession(
  supabase: SupabaseClient,
  params: TrialSessionAuthorizationParams,
): Promise<TrialSessionAuthorizationResult> {
  const { data, error } = await supabase.rpc('authorize_trial_conversation_session_v1', {
    p_user_id: params.userId,
    p_requested_max_seconds: Math.floor(params.requestedMaxSeconds),
    p_session_date: params.sessionDate,
    p_gateway_budget_reservation_id: params.gatewayBudgetReservationId,
    p_gateway_session_id: params.gatewaySessionId,
    p_idempotency_key: params.idempotencyKey,
  });
  if (error) throw new Error(`authorize_trial_conversation_session_v1 failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as AuthorizeTrialSessionRow | undefined;
  if (!row) return { authorizationId: null, authorizedMaxSeconds: 0, blocked: true, blockedReason: 'no_active_trial' };
  return {
    authorizationId: row.authorization_id,
    authorizedMaxSeconds: row.authorized_max_seconds,
    blocked: row.blocked,
    blockedReason: row.blocked_reason,
  };
}

/** Attaches the gateway session/budget-reservation ids known only after the
 *  OpenAI call succeeds — the early atomic insert (authorizeTrialConversationSession
 *  above) runs BEFORE those ids exist, unlike the commercial-plan plain
 *  insert which happens after and sets them in one write. Best-effort: a
 *  failure here never blocks the token already returned to the student —
 *  worst case this call's reconciliation later finds no ids to act on,
 *  which /session-complete already treats as a no-op release. */
export async function attachTrialConversationSessionGatewayIds(
  supabase: SupabaseClient,
  authorizationId: string,
  gatewayBudgetReservationId: string | null,
  gatewaySessionId: string | null,
): Promise<void> {
  await supabase
    .from('conversation_session_authorizations')
    .update({
      gateway_budget_reservation_id: gatewayBudgetReservationId,
      gateway_session_id: gatewaySessionId,
    })
    .eq('id', authorizationId)
    .eq('status', 'authorized');
}

/** Releases (deletes) a trial authorization row created early but never
 *  used because the OpenAI call ultimately failed — mirrors releasing the
 *  $ budget reservation on the same failure path
 *  (releaseSessionReservation(..., 'session_never_started')). The row never
 *  represented real usage, so no accounting is lost by removing it; leaving
 *  it would otherwise permanently (never released/expired) hold part of the
 *  trial's lifetime balance for a session that never actually started. */
export async function releaseTrialConversationSessionAuthorization(
  supabase: SupabaseClient,
  authorizationId: string,
): Promise<void> {
  await supabase
    .from('conversation_session_authorizations')
    .delete()
    .eq('id', authorizationId)
    .eq('status', 'authorized');
}
