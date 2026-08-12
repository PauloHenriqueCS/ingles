/**
 * SERVER-ONLY: debits purchased conversation minute credits
 * (user_conversation_credits.remaining_seconds) for the OVER-PLAN portion of a
 * just-finalized conversation session. Called from BOTH session-finalize sites
 * (handleSessionComplete and the abandoned-session sweep), right after the
 * guarded status 'authorized' -> 'completed' UPDATE wins.
 *
 * Order of consumption (the existing display/gating rule — see
 * compute-feature-state.ts): plan-included minutes first, purchased credits
 * second. So only seconds beyond the plan's remaining monthly minutes are
 * debited. The actual split + FIFO-by-expiry decrement happens atomically in
 * debit_conversation_extra_credits_v1, which is idempotent per authorization
 * (extra_credits_debited_at) — a retry / sweep / crash-recovery never
 * double-debits.
 *
 * Best-effort by contract: the caller wraps this so a debit failure NEVER fails
 * session finalization (the quota is already recorded on
 * conversation_session_authorizations). A missed debit only under-charges the
 * ledger, never over-charges and never breaks the call.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { getCurrentUserPlanEntitlements } from './plan-entitlements-service';

export async function settleConversationExtraCreditsDebit(
  userId: string,
  authorizationId: string,
  durationSeconds: number,
  deps?: { supabase?: SupabaseClient; now?: Date },
): Promise<number> {
  if (durationSeconds <= 0) return 0;

  const entitlements = await getCurrentUserPlanEntitlements(userId, deps);
  const monthly = entitlements.conversation.monthlyTime;

  // Unlimited (internal) plans never burn credits; and if there is no purchased
  // balance at all, there is nothing to debit — skip the RPC round-trip.
  if (monthly.unlimited) return 0;
  if ((entitlements.conversation.extraSecondsAvailable ?? 0) <= 0) return 0;

  const supabase = deps?.supabase ?? getSharedServiceClient();
  const { data, error } = await supabase.rpc('debit_conversation_extra_credits_v1', {
    p_user_id: userId,
    p_authorization_id: authorizationId,
    p_plan_limit_seconds: monthly.limit,
  });
  if (error) throw new Error(`debit_conversation_extra_credits_v1 failed: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}
