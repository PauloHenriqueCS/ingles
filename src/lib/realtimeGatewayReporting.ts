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
// fetch() only REJECTS on a network failure — it resolves normally for any
// HTTP status, including 401/404/500. Without checking response.ok, a
// rejected/broken bridge call is invisible everywhere: no console output,
// no way to ever notice it in production. This still never throws and never
// blocks the conversation (fail-open) — it only makes a real failure
// observable instead of silently vanishing.

function logBridgeFailure(path: string, body: Record<string, unknown>, detail: { status?: number; errorCode: string }): void {
  // Sanitized only: logical endpoint, HTTP status, technical error code, and
  // whether a gatewaySessionId was present — never the token, transcript,
  // audio, SDP, or any other request/response content.
  console.error('[realtimeGatewayReporting] bridge call failed', {
    endpoint: path,
    status: detail.status ?? null,
    errorCode: detail.errorCode,
    hasGatewaySessionId: typeof body.gatewaySessionId === 'string' && body.gatewaySessionId.length > 0,
  });
}

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const headers = await getAuthHeader();
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logBridgeFailure(path, body, { status: res.status, errorCode: `HTTP_${res.status}` });
    }
  } catch {
    // Network failure, or getAuthHeader() itself threw — telemetry must
    // never affect the conversation, but the failure is still observable.
    logBridgeFailure(path, body, { errorCode: 'NETWORK_ERROR' });
  }
}

// ── Public reporting calls ────────────────────────────────────────────────────

// Flat, single-segment routes — NOT /session/active etc. A nested sub-path
// under api/conversation/[...slug].ts 404'd in production: Vercel never
// routed the extra path segment into the function at all (confirmed by
// real HTTP 404s with gatewaySessionId present, before requireAuth was ever
// reached). /api/conversation/session already deploys correctly as a flat
// segment, so every bridge route uses that same proven shape.

/** Reports that the physical WebRTC connection succeeded and the session is live. */
export function reportSessionActive(gatewaySessionId: string): void {
  void post('/api/conversation/session-active', { gatewaySessionId });
}

/** Reports that the connection attempt failed (before or during establishment). */
export function reportSessionFailed(gatewaySessionId: string, reason: SessionEndReason): void {
  void post('/api/conversation/session-failed', { gatewaySessionId, reason });
}

/** Relays one Realtime response.done usage event, verbatim numeric counters only. */
export function reportSessionUsage(
  gatewaySessionId: string,
  providerResponseId: string,
  usage: Record<string, unknown>,
): void {
  void post('/api/conversation/session-usage', { gatewaySessionId, providerResponseId, usage });
}

/**
 * Reports normal session completion. Carries no duration — the backend
 * computes session_seconds itself from server-controlled timestamps
 * (ai_provider_sessions.started_at, set at session-active, through its own
 * clock at session-end). A client-reported duration is never trusted.
 */
export function reportSessionEnd(gatewaySessionId: string): void {
  void post('/api/conversation/session-end', { gatewaySessionId });
}

// ── Session control poll (Etapa 11, Fase 9) ──────────────────────────────────
// Unlike the reports above, this one has a real answer the caller needs
// (terminate: true/false), so it can't reuse the fire-and-forget post()
// helper. Still best-effort: any failure (network, non-2xx, malformed body)
// resolves to "don't terminate" — a telemetry/poll failure must never cut
// off an otherwise-healthy conversation. useRealtimeSession.ts only calls
// this while gatewaySessionId is set (never in legacy mode) and the session
// is actively connected.

export interface SessionControlResult {
  terminate: boolean;
  reason?: string;
}

export async function checkSessionControl(gatewaySessionId: string): Promise<SessionControlResult> {
  try {
    const headers = await getAuthHeader();
    const res = await fetch('/api/conversation/session-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ gatewaySessionId }),
    });
    if (!res.ok) {
      logBridgeFailure('/api/conversation/session-control', { gatewaySessionId }, { status: res.status, errorCode: `HTTP_${res.status}` });
      return { terminate: false };
    }
    const body = await res.json() as { terminate?: unknown; reason?: unknown };
    return {
      terminate: body.terminate === true,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    };
  } catch {
    logBridgeFailure('/api/conversation/session-control', { gatewaySessionId }, { errorCode: 'NETWORK_ERROR' });
    return { terminate: false };
  }
}
