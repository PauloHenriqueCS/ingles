/**
 * SERVER-ONLY shared accounting for closing a conversation authorization row
 * (conversation_session_authorizations). This is the SINGLE source of the
 * abandoned/completed duration formula and of the "close one row" side effects
 * (mirror into the quota table, reconcile the gateway budget reservation, debit
 * extra credits) — so the cooperative /session-complete path, the reconcile-on-
 * start path, and the background sweep all charge minutes exactly one way and
 * can never diverge into a second billing formula.
 *
 * It deliberately does NOT grant curricular credit: an abandoned/force-closed
 * session must never earn guided practice credit (only the cooperative
 * /session-complete grants it, under the existing rule). Underscore-prefixed so
 * Vercel never treats it as a Serverless Function.
 */
import { getProductionDeps, reconcileSessionReservation, releaseSessionReservation } from '../_ai-gateway/index';
import { settleConversationExtraCreditsDebit } from '../_entitlements/conversation-extra-credits-debit';
import { AUTHORIZATION_HEARTBEAT_STALE_SECONDS } from '../_realtime-constants';

export interface AuthorizationRow {
  id: string;
  user_id: string;
  session_date: string;
  authorized_at: string;
  authorized_max_seconds: number;
  /** Client heartbeat (null on rows created before the heartbeat feature). */
  last_seen_at?: string | null;
  gateway_budget_reservation_id: string | null;
  gateway_session_id: string | null;
}

type Logger = (event: string, detail: unknown) => void;

/** The ONE duration formula, shared by every close path. */
export function computeAuthorizationDurationSeconds(row: AuthorizationRow, effectiveEndMs: number): number {
  const authorizedAtMs = new Date(row.authorized_at).getTime();
  const elapsedSeconds = (effectiveEndMs - authorizedAtMs) / 1000;
  return Math.floor(Math.max(0, Math.min(elapsedSeconds, row.authorized_max_seconds)));
}

/** Milliseconds of the last credible client heartbeat (falls back to start). */
function lastSeenMs(row: AuthorizationRow): number {
  return row.last_seen_at ? new Date(row.last_seen_at).getTime() : new Date(row.authorized_at).getTime();
}

/** True when the client heartbeat has gone quiet beyond the stale window. */
export function isHeartbeatStale(row: AuthorizationRow, nowMs: number): boolean {
  return nowMs - lastSeenMs(row) > AUTHORIZATION_HEARTBEAT_STALE_SECONDS * 1000;
}

/**
 * The authoritative end timestamp for a still-open, abandoned row.
 * - With a heartbeat: the last beat + the stale window (EVIDENCE lets us clamp,
 *   so the user is charged only for the time they were genuinely present, plus
 *   at most one stale window; the balance stops climbing the moment they leave).
 * - Without a heartbeat (legacy row): `now` — the previous behavior, so a
 *   pre-heartbeat row is never retroactively refunded without evidence.
 */
export function abandonedEffectiveEndMs(row: AuthorizationRow, nowMs: number): number {
  if (!row.last_seen_at) return nowMs;
  return Math.min(nowMs, lastSeenMs(row) + AUTHORIZATION_HEARTBEAT_STALE_SECONDS * 1000);
}

/**
 * Atomically close ONE 'authorized' row → 'completed' with the given duration,
 * then run the shared side effects. The status guard on the UPDATE is the single
 * point of atomicity: a racing caller (cooperative complete, another sweep tick)
 * matches no rows and is a harmless no-op. Returns whether THIS call won.
 */
export async function closeAuthorizationRow(
  client: any,
  row: AuthorizationRow,
  durationSeconds: number,
  nowMs: number,
  log?: Logger,
): Promise<boolean> {
  const { data: updated } = await client
    .from('conversation_session_authorizations')
    .update({ status: 'completed', completed_at: new Date(nowMs).toISOString(), duration_seconds: durationSeconds })
    .eq('id', row.id)
    .eq('status', 'authorized')
    .select('id')
    .maybeSingle();
  if (!updated) return false;

  // conversation_sessions.duration_sec has CHECK (duration_sec > 0).
  if (durationSeconds > 0) {
    const { error: insertErr } = await client
      .from('conversation_sessions')
      .insert({ user_id: row.user_id, session_date: row.session_date, duration_sec: durationSeconds });
    if (insertErr) log?.('mirror_duration_failed', insertErr.message);
  }

  // Reconcile the upfront realtime budget reservation against real cost (or
  // release it if there is no gateway session to reconcile against).
  if (row.gateway_budget_reservation_id) {
    try {
      const deps = getProductionDeps();
      if (row.gateway_session_id) {
        await reconcileSessionReservation(deps, 'conversation.realtime_usage', row.gateway_budget_reservation_id, row.gateway_session_id);
      } else {
        await releaseSessionReservation(deps, row.gateway_budget_reservation_id, 'no_gateway_session_to_reconcile_against');
      }
    } catch (e) {
      log?.('budget_reconcile_failed', e instanceof Error ? e.message : String(e));
    }
  }

  // Debit purchased extra-minute credits for the over-plan portion (idempotent
  // per authorization) — same RPC the cooperative path uses.
  try {
    await settleConversationExtraCreditsDebit(row.user_id, row.id, durationSeconds, { supabase: client });
  } catch (e) {
    log?.('extra_credits_debit_failed', e instanceof Error ? e.message : String(e));
  }
  return true;
}

/**
 * Reconcile-on-read/start: close every one of THIS user's own 'authorized' rows
 * whose heartbeat has gone stale, charging only the time genuinely present.
 * Called before authorizing a new session (and any balance-driven entry point)
 * so an abandoned session can never stay "active" indefinitely, independent of
 * any background cron. Never grants curricular credit. Best-effort; returns the
 * count closed.
 */
export async function reconcileUserStaleAuthorizations(
  client: any,
  userId: string,
  nowMs: number,
  log?: Logger,
): Promise<number> {
  const { data: openRows } = await client
    .from('conversation_session_authorizations')
    .select('id, user_id, session_date, authorized_at, authorized_max_seconds, last_seen_at, gateway_budget_reservation_id, gateway_session_id')
    .eq('user_id', userId)
    .eq('status', 'authorized');

  let closed = 0;
  for (const row of (openRows ?? []) as AuthorizationRow[]) {
    if (!isHeartbeatStale(row, nowMs)) continue; // a genuinely live session is never touched
    const durationSeconds = computeAuthorizationDurationSeconds(row, abandonedEffectiveEndMs(row, nowMs));
    if (await closeAuthorizationRow(client, row, durationSeconds, nowMs, log)) closed++;
  }
  return closed;
}

/**
 * Close EVERY one of this user's own still-open ('authorized') rows before we
 * authorize a NEW session — regardless of heartbeat staleness. Starting a new
 * session means any prior one is definitively over, so its upfront full-ceiling
 * reservation must be released and converted to the real time used; otherwise a
 * session abandoned within the stale window keeps its whole ceiling reserved and
 * the next authorization (and the top balance) diverge — the balance reads the
 * live-elapsed seconds while the authorize RPC still subtracts the full ceiling,
 * so the session is authorized for a tiny window while the header shows minutes
 * left. This is the fix for that divergence + premature end.
 *
 * Effective end = the last credible heartbeat (never `now`), so superseding an
 * abandoned session bills only the time the user was provably present and never
 * charges silence. Legacy rows with no heartbeat fall back to `now` (no evidence
 * to refund). Reuses the ONE shared close path, so the balance is charged
 * exactly one way. Never grants curricular credit. Best-effort; returns count.
 */
export async function closeUserOpenAuthorizationsForNewSession(
  client: any,
  userId: string,
  nowMs: number,
  log?: Logger,
): Promise<number> {
  const { data: openRows } = await client
    .from('conversation_session_authorizations')
    .select('id, user_id, session_date, authorized_at, authorized_max_seconds, last_seen_at, gateway_budget_reservation_id, gateway_session_id')
    .eq('user_id', userId)
    .eq('status', 'authorized');

  let closed = 0;
  for (const row of (openRows ?? []) as AuthorizationRow[]) {
    const effectiveEndMs = row.last_seen_at ? Math.min(nowMs, lastSeenMs(row)) : nowMs;
    const durationSeconds = computeAuthorizationDurationSeconds(row, effectiveEndMs);
    if (await closeAuthorizationRow(client, row, durationSeconds, nowMs, log)) closed++;
  }
  return closed;
}
