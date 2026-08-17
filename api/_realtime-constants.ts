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

// Heartbeat window for the conversation QUOTA authorization row itself
// (conversation_session_authorizations.last_seen_at) — distinct from the
// ai_provider_sessions telemetry heartbeat above. While a conversation is
// genuinely open the client renews last_seen_at every
// ~AUTHORIZATION_HEARTBEAT_INTERVAL_SECONDS (see src/hooks/useRealtimeSession.ts),
// independent of gateway observe-mode. When the client leaves the screen,
// backgrounds, crashes or is killed, the heartbeat stops; beyond this window
// the authorization is treated as abandoned and (a) its live minute
// consumption is CLAMPED to the last heartbeat (so the balance stops climbing
// the moment the user leaves) and (b) the row is force-closed by
// reconcile-on-start / the sweep. Set to a few missed beats so ordinary
// jitter never closes a healthy session. Rows created before this feature
// carry last_seen_at = NULL and keep the previous (unclamped) behavior — a
// heartbeat is EVIDENCE that lets us clamp; without it we never refund.
export const AUTHORIZATION_HEARTBEAT_INTERVAL_SECONDS = 20;
export const AUTHORIZATION_HEARTBEAT_STALE_SECONDS = 75;
