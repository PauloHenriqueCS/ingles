/**
 * SERVER-ONLY — real OpenAI Realtime call termination + outcome persistence.
 *
 * Shared by api/conversation/[...slug].ts's session-control terminate path
 * and api/internal/conversation/sweep.ts's abandoned-session cleanup — both
 * need the exact same "call the real hangup endpoint, then durably record
 * what actually happened" behavior, and must never diverge into two
 * different notions of what a successful hangup means.
 */

import { getSharedServiceClient } from './_ai-gateway/index';
import { TIMEOUTS } from './_helpers';

export interface HangupOutcome {
  ok: boolean;
  httpStatus: number | null;
}

// Documented OpenAI Realtime endpoint (audited against current API
// reference): a call created via POST /v1/realtime/calls can be forcibly
// ended via POST /v1/realtime/calls/{call_id}/hangup, authenticated with
// the real (server-only) API key — never the ephemeral client token.
// Idempotent by construction: hanging up an already-ended call is expected
// to fail harmlessly on OpenAI's side (4xx), treated the same as a
// completed hangup here — there is nothing further to clean up locally
// either way, and the caller (session-control, the sweep job) always
// proceeds with its own termination regardless of this outcome.
export async function hangupRealtimeCall(callId: string): Promise<HangupOutcome> {
  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) return { ok: false, httpStatus: null };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUTS.SHORT);
    try {
      const resp = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}` },
        signal: ctrl.signal,
      });
      return { ok: resp.ok, httpStatus: resp.status };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, httpStatus: null };
  }
}

/**
 * Calls hangupRealtimeCall and durably persists the outcome onto the
 * ai_provider_sessions row — status ('ok'/'failed'/'not_attempted'),
 * timestamp, and the raw HTTP status code only (never the response body,
 * which could carry provider error detail not meant for long-term
 * storage). Best-effort: a persistence failure is logged, never thrown —
 * callers must never let this block their own termination flow.
 */
export async function hangupAndPersist(gatewaySessionId: string, callId: string): Promise<HangupOutcome> {
  const outcome = await hangupRealtimeCall(callId);
  try {
    await getSharedServiceClient()
      .from('ai_provider_sessions')
      .update({
        hangup_status: outcome.ok ? 'ok' : 'failed',
        hangup_at: new Date().toISOString(),
        hangup_http_status: outcome.httpStatus,
      })
      .eq('id', gatewaySessionId);
  } catch (e) {
    console.error('[realtime-hangup] failed to persist hangup outcome', e instanceof Error ? e.message : 'unknown');
  }
  return outcome;
}
