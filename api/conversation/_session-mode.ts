/**
 * Server-authoritative resolution of a conversation session's MODE and its
 * curricular CREDIT eligibility. Kept as small pure functions so the rules can
 * be unit-tested exhaustively and reused, and so the security-critical
 * invariant — a client parameter can never, by itself, falsify curricular
 * credit — lives in one obvious place.
 *
 * See api/conversation/[...slug].ts (handleSession) for the call sites: mode is
 * resolved at session START and the eligibility + curricular identity are then
 * FROZEN onto conversation_session_authorizations, so completion credits from
 * persisted server state, never from anything the client sends later.
 */

export type SessionMode = 'guided' | 'free';

/**
 * Resolve the session mode from the (optional) client request and the user's
 * teaching-plan selection.
 *
 * - An explicit `mode: 'free'` always yields FREE — a dedicated free-chat entry
 *   the user can pick even when Conversation is a required modality.
 * - An explicit `mode: 'guided'` yields GUIDED — the user chose to practise the
 *   current recorte. (Whether it EARNS credit is a separate decision — see
 *   computeGuidedEligible — so offering Guided never silently turns Conversation
 *   into a progression requirement.)
 * - No explicit mode → GUIDED iff Conversation is a selected modality, else FREE.
 *   This preserves the previous, plan-derived behavior for older clients that
 *   send no `mode` at all (backward compatible).
 */
export function resolveSessionMode(params: {
  requestedMode: unknown;
  conversationInPlan: boolean;
}): SessionMode {
  const { requestedMode, conversationInPlan } = params;
  if (requestedMode === 'free') return 'free';
  if (requestedMode === 'guided') return 'guided';
  return conversationInPlan ? 'guided' : 'free';
}

/**
 * Whether this session may EARN curricular credit for Conversation.
 *
 * Credit is a purely server-side decision, independent of what the client asked
 * for. ALL THREE must hold:
 *  1. the session was born GUIDED;
 *  2. Conversation is a SELECTED modality in the teaching plan (menu = regra) —
 *     so a client-forced guided session on a plan that did NOT select
 *     Conversation is guided pedagogically but NEVER creditable, and thus never
 *     makes Conversation a progression requirement the user didn't opt into;
 *  3. a real current recorte (curriculum version + subtopic) exists to credit.
 *
 * FREE is never eligible. Because eligibility is frozen at start, toggling the
 * modality mid-session can never change whether the session counts.
 */
export function computeGuidedEligible(params: {
  sessionMode: SessionMode;
  conversationInPlan: boolean;
  hasCurricularIdentity: boolean;
}): boolean {
  return (
    params.sessionMode === 'guided' &&
    params.conversationInPlan &&
    params.hasCurricularIdentity
  );
}
