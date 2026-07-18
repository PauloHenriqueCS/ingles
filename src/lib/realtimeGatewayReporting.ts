/**
 * Fire-and-forget reporting for the conversation.webrtc_connect /
 * conversation.realtime_usage AI Gateway bridge.
 *
 * Every function here is best-effort: it never throws, never blocks, and
 * its result is never awaited by useRealtimeSession.ts — a failure (network
 * error, backend down, telemetry disabled) must never affect the actual
 * conversation. Nothing is sent unless the backend already returned a
 * gatewaySessionId (only present when conversation.webrtc_connect is in
 * observe mode) — in legacy mode these functions are simply never called.
 *
 * Only technical, non-content data crosses this boundary: a session id, a
 * response id, numeric token counters copied verbatim from the official
 * OpenAI Realtime response.done event, a small enum reason, and a duration
 * in seconds. Never the transcript, prompt, SDP, or the ephemeral token.
 */

import { getAuthHeader } from './apiAuth';

// ── End/failure reason — small, backend-validated vocabulary ────────────────

export type SessionEndReason =
  | 'user_ended'
  | 'dc_closed'
  | 'max_duration_reached'
  | 'unmounted'
  | 'connection_lost'
  | 'webrtc_failed'
  | 'webrtc_network'
  | 'session_error'
  | 'unknown';

const KNOWN_END_REASONS = new Set<SessionEndReason>([
  'user_ended', 'dc_closed', 'max_duration_reached', 'unmounted',
  'connection_lost', 'webrtc_failed', 'webrtc_network', 'session_error', 'unknown',
]);

// Maps useRealtimeSession's internal fail() error codes (defined in that
// file) to the small reason vocabulary the backend accepts. Codes that only
// ever occur BEFORE a gatewaySessionId exists (e.g. mic permission errors)
// are irrelevant here — reportSessionFailed is never called for those,
// since the hook only reports once it holds a gatewaySessionId at all.
const FAIL_CODE_TO_REASON: Record<string, SessionEndReason> = {
  CONNECTION_LOST: 'connection_lost',
  WEBRTC_FAILED: 'webrtc_failed',
  WEBRTC_NETWORK: 'webrtc_network',
  SESSION_ERROR: 'session_error',
};

/** Maps an internal hook reason/code to the backend's validated reason enum. */
export function toSessionEndReason(code: string | null | undefined): SessionEndReason {
  if (!code) return 'unknown';
  if (KNOWN_END_REASONS.has(code as SessionEndReason)) return code as SessionEndReason;
  return FAIL_CODE_TO_REASON[code] ?? 'unknown';
}

// ── Transport ────────────────────────────────────────────────────────────────

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const headers = await getAuthHeader();
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    // Telemetry must never affect the conversation — swallow every failure.
  }
}

// ── Public reporting calls ────────────────────────────────────────────────────

/** Reports that the physical WebRTC connection succeeded and the session is live. */
export function reportSessionActive(gatewaySessionId: string): void {
  void post('/api/conversation/session/active', { gatewaySessionId });
}

/** Reports that the connection attempt failed (before or during establishment). */
export function reportSessionFailed(gatewaySessionId: string, reason: SessionEndReason): void {
  void post('/api/conversation/session/failed', { gatewaySessionId, reason });
}

/** Relays one Realtime response.done usage event, verbatim numeric counters only. */
export function reportSessionUsage(
  gatewaySessionId: string,
  providerResponseId: string,
  usage: Record<string, unknown>,
): void {
  void post('/api/conversation/session/usage', { gatewaySessionId, providerResponseId, usage });
}

/**
 * Reports normal session completion. Carries no duration — the backend
 * computes session_seconds itself from server-controlled timestamps
 * (ai_provider_sessions.started_at, set at /session/active, through its own
 * clock at /session/end). A client-reported duration is never trusted.
 */
export function reportSessionEnd(gatewaySessionId: string): void {
  void post('/api/conversation/session/end', { gatewaySessionId });
}
