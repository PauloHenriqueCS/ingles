/**
 * SERVER-ONLY — tiny shared constants for the conversation.webrtc_connect
 * realtime session lifecycle.
 *
 * Deliberately NOT defined inside api/conversation/[...slug].ts (even
 * though that's their only "natural" home): that file is itself a Vercel
 * function entry point, and api/internal/listening/[...slug].ts's
 * conversation-sweep route (a different entry point — see that file's own
 * doc comment for why it lives there) needs the exact same values. Two
 * entry-point files importing from each other works at the TS/bundler
 * level, but keeping shared constants in a plain, non-route module is the
 * same pattern already used for every other cross-cutting piece in this
 * codebase (api/_helpers.ts, api/_auth.ts, api/_realtime-hangup.ts, ...).
 */

export const WEBRTC_CONNECT_FEATURE_KEY = 'conversation.webrtc_connect';

// Server-authoritative Realtime session ceiling (Etapa 11, Fase 9) — see
// api/conversation/[...slug].ts's handleSessionControl for the original
// rationale. Also used by the sweep job as the outer safety-net deadline
// (a session should never legitimately still be 'active' this long after
// started_at, heartbeat or no heartbeat).
export const REALTIME_MAX_SESSION_SECONDS = 30 * 60;

// Heartbeat/lease window (Etapa 11 realtime hardening). handleSessionActive
// and every handleSessionControl poll renew last_heartbeat_at while a
// client is genuinely still there (polls every ~5s — see
// SESSION_CONTROL_POLL_MS in src/hooks/useRealtimeSession.ts). A session
// whose heartbeat has gone quiet for longer than this window is treated as
// abandoned (tab closed, crash, lost network — session-control simply
// stopped being called) and force-closed by the sweep job. Set well above
// the 5s poll interval to absorb normal jitter/a single dropped poll
// without ever closing a session that is actually still healthy.
export const REALTIME_HEARTBEAT_STALE_SECONDS = 60;

// Grace period added on top of authorized_max_seconds before an
// 'authorized' conversation_session_authorizations row (opened at /session
// time, never activated or never completed) is considered abandoned by the
// sweep job. Generous on purpose: a slow client, network retry, or a
// session that connects right at the edge of its authorized window must
// never be closed out from under it while it may still complete normally
// through the cooperative /session-complete path.
export const AUTHORIZATION_SWEEP_GRACE_SECONDS = 120;
