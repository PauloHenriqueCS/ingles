/**
 * Shared abandon/complete accounting for conversation authorizations. The core
 * hotfix guarantee: an abandoned session is charged for its REAL (heartbeat-
 * clamped) duration and closed exactly once — never billed up to the ceiling,
 * never granted curricular credit, never double-charged.
 */
import { describe, it, expect, vi } from 'vitest';

// The shared helper reaches into the AI-gateway/entitlements deps for the side
// effects (reservation reconcile, extra-credits debit). Stub them so the pure
// accounting logic can be exercised without a real gateway/DB.
vi.mock('../_ai-gateway/index', () => ({
  getProductionDeps: () => ({ clock: () => 1_000_000, logger: vi.fn() }),
  reconcileSessionReservation: vi.fn().mockResolvedValue(undefined),
  releaseSessionReservation: vi.fn().mockResolvedValue(undefined),
}));
const mockSettleDebit = vi.fn().mockResolvedValue(undefined);
vi.mock('../_entitlements/conversation-extra-credits-debit', () => ({
  settleConversationExtraCreditsDebit: (...args: unknown[]) => mockSettleDebit(...args),
}));

import {
  computeAuthorizationDurationSeconds,
  isHeartbeatStale,
  abandonedEffectiveEndMs,
  closeAuthorizationRow,
  reconcileUserStaleAuthorizations,
  closeUserOpenAuthorizationsForNewSession,
  type AuthorizationRow,
} from '../conversation/_session-accounting';
import { AUTHORIZATION_HEARTBEAT_STALE_SECONDS } from '../_realtime-constants';

const STALE_MS = AUTHORIZATION_HEARTBEAT_STALE_SECONDS * 1000;
const T0 = 1_000_000_000_000; // fixed base "authorized_at" ms

function row(overrides: Partial<AuthorizationRow> = {}): AuthorizationRow {
  return {
    id: 'auth-1', user_id: 'u1', session_date: '2026-08-17',
    authorized_at: new Date(T0).toISOString(),
    authorized_max_seconds: 1800, // 30 min ceiling
    last_seen_at: null,
    gateway_budget_reservation_id: null, gateway_session_id: null,
    ...overrides,
  };
}

describe('computeAuthorizationDurationSeconds', () => {
  it('charges real elapsed, floored', () => {
    expect(computeAuthorizationDurationSeconds(row(), T0 + 102_500)).toBe(102); // 102.5s → 102
  });
  it('never charges below 0', () => {
    expect(computeAuthorizationDurationSeconds(row(), T0 - 5000)).toBe(0);
  });
  it('clamps to the authorized ceiling (never over the max)', () => {
    expect(computeAuthorizationDurationSeconds(row({ authorized_max_seconds: 1800 }), T0 + 3_600_000)).toBe(1800);
  });
});

describe('isHeartbeatStale / abandonedEffectiveEndMs', () => {
  it('a fresh heartbeat is NOT stale (a live session is never touched)', () => {
    const r = row({ last_seen_at: new Date(T0 + 100_000).toISOString() });
    expect(isHeartbeatStale(r, T0 + 100_000 + STALE_MS - 1)).toBe(false);
  });
  it('a heartbeat quiet beyond the window IS stale', () => {
    const r = row({ last_seen_at: new Date(T0 + 100_000).toISOString() });
    expect(isHeartbeatStale(r, T0 + 100_000 + STALE_MS + 1)).toBe(true);
  });
  it('clamps the effective end to last heartbeat + stale window (real usage, not the ceiling)', () => {
    // User genuinely present ~102s (last beat at +102s), then walked away; now is
    // 20 minutes later. Charge ~102s + one stale window, NEVER the 30-min max.
    const lastSeen = T0 + 102_000;
    const r = row({ last_seen_at: new Date(lastSeen).toISOString() });
    const end = abandonedEffectiveEndMs(r, T0 + 20 * 60_000);
    expect(end).toBe(lastSeen + STALE_MS);
    expect(computeAuthorizationDurationSeconds(r, end)).toBe(102 + AUTHORIZATION_HEARTBEAT_STALE_SECONDS);
  });
  it('with NO heartbeat (legacy row) falls back to now — no retroactive refund', () => {
    const r = row({ last_seen_at: null });
    expect(abandonedEffectiveEndMs(r, T0 + 500_000)).toBe(T0 + 500_000);
    // legacy staleness measured from authorized_at
    expect(isHeartbeatStale(r, T0 + STALE_MS + 1)).toBe(true);
  });
});

// ── Chainable in-memory Supabase stub capturing writes ────────────────────────
function makeClient(opts: { updateReturnsRow?: boolean } = {}) {
  const inserted: any[] = [];
  const updates: any[] = [];
  let openRows: AuthorizationRow[] = [];
  const client: any = {
    _inserted: inserted, _updates: updates,
    _setOpenRows(rows: AuthorizationRow[]) { openRows = rows; },
    from(table: string) {
      const ctx: any = { table, _update: null };
      const chain: any = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        insert(rowVal: any) { inserted.push({ table, row: rowVal }); return Promise.resolve({ data: null, error: null }); },
        update(vals: any) { ctx._update = vals; updates.push({ table, vals }); return chain; },
        maybeSingle() {
          if (ctx._update) {
            return Promise.resolve({ data: (opts.updateReturnsRow ?? true) ? { id: 'auth-1' } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: any) => any) {
          // select() on the open-rows query resolves to the seeded rows
          return resolve({ data: openRows, error: null });
        },
      };
      return chain;
    },
  };
  return client;
}

describe('closeAuthorizationRow', () => {
  it('closes the row and mirrors real duration into the quota table', async () => {
    const client = makeClient();
    const ok = await closeAuthorizationRow(client, row(), 102, T0 + 200_000);
    expect(ok).toBe(true);
    const upd = client._updates.find((u: any) => u.table === 'conversation_session_authorizations');
    expect(upd.vals.status).toBe('completed');
    expect(upd.vals.duration_seconds).toBe(102);
    const mirror = client._inserted.find((i: any) => i.table === 'conversation_sessions');
    expect(mirror.row.duration_sec).toBe(102);
  });

  it('does NOT mirror a zero-duration session (CHECK duration_sec > 0)', async () => {
    const client = makeClient();
    await closeAuthorizationRow(client, row(), 0, T0);
    expect(client._inserted.find((i: any) => i.table === 'conversation_sessions')).toBeUndefined();
  });

  it('is idempotent: a losing race (guarded UPDATE matches no row) returns false and no side effects', async () => {
    const client = makeClient({ updateReturnsRow: false });
    const ok = await closeAuthorizationRow(client, row(), 102, T0 + 200_000);
    expect(ok).toBe(false);
    expect(client._inserted.length).toBe(0);
  });
});

describe('reconcileUserStaleAuthorizations', () => {
  it('closes a stale open row with clamped duration, leaves a live one untouched', async () => {
    const nowMs = T0 + 20 * 60_000; // 20 min later
    const stale = row({ id: 'stale', last_seen_at: new Date(T0 + 102_000).toISOString() });
    const live = row({ id: 'live', last_seen_at: new Date(nowMs - 5_000).toISOString() });
    const client = makeClient();
    client._setOpenRows([stale, live]);

    const closed = await reconcileUserStaleAuthorizations(client, 'u1', nowMs);
    expect(closed).toBe(1); // only the stale one
    const upd = client._updates.find((u: any) => u.table === 'conversation_session_authorizations');
    // clamped to last_seen + stale window = 102 + STALE seconds, never 20 min
    expect(upd.vals.duration_seconds).toBe(102 + AUTHORIZATION_HEARTBEAT_STALE_SECONDS);
    expect(upd.vals.duration_seconds).toBeLessThan(1800);
  });

  it('a 60s session that is then abandoned is charged ~60s (+one window), never 30 minutes', async () => {
    const lastSeen = T0 + 60_000;
    const abandoned = row({ id: 'a', last_seen_at: new Date(lastSeen).toISOString() });
    const client = makeClient();
    client._setOpenRows([abandoned]);
    await reconcileUserStaleAuthorizations(client, 'u1', T0 + 30 * 60_000);
    const upd = client._updates.find((u: any) => u.table === 'conversation_session_authorizations');
    expect(upd.vals.duration_seconds).toBe(60 + AUTHORIZATION_HEARTBEAT_STALE_SECONDS);
  });

  it('does nothing when there are no stale open rows', async () => {
    const client = makeClient();
    client._setOpenRows([]);
    expect(await reconcileUserStaleAuthorizations(client, 'u1', T0 + 1000)).toBe(0);
  });
});

describe('closeUserOpenAuthorizationsForNewSession (balance-consistency fix)', () => {
  it('closes EVERY open row — including a not-yet-stale one — so no phantom reservation survives', async () => {
    const nowMs = T0 + 5 * 60_000;
    // Abandoned 10s ago: heartbeat is still "fresh" (< stale window) so the
    // stale reconcile would SKIP it, leaving its whole ceiling reserved.
    const recentlyAbandoned = row({ id: 'r1', last_seen_at: new Date(nowMs - 10_000).toISOString() });
    const alsoOpen = row({ id: 'r2', last_seen_at: new Date(T0 + 40_000).toISOString() });
    const client = makeClient();
    client._setOpenRows([recentlyAbandoned, alsoOpen]);

    const closed = await closeUserOpenAuthorizationsForNewSession(client, 'u1', nowMs);
    expect(closed).toBe(2); // both closed, unlike the stale-only reconcile
    const authUpdates = client._updates.filter((u: any) => u.table === 'conversation_session_authorizations');
    expect(authUpdates.length).toBe(2);
    expect(authUpdates.every((u: any) => u.vals.status === 'completed')).toBe(true);
  });

  it('charges only up to the last heartbeat (never bills silence up to now)', async () => {
    const nowMs = T0 + 10 * 60_000; // 10 min later
    const lastSeen = T0 + 54_000;   // user last provably present at 54s
    const r = row({ id: 'r', last_seen_at: new Date(lastSeen).toISOString() });
    const client = makeClient();
    client._setOpenRows([r]);
    await closeUserOpenAuthorizationsForNewSession(client, 'u1', nowMs);
    const upd = client._updates.find((u: any) => u.table === 'conversation_session_authorizations');
    // exactly 54s — NOT 54 + stale window, and NOT the 30-min ceiling
    expect(upd.vals.duration_seconds).toBe(54);
  });

  it('legacy row with no heartbeat falls back to now (no evidence to refund)', async () => {
    const nowMs = T0 + 120_000;
    const legacy = row({ id: 'legacy', last_seen_at: null, authorized_max_seconds: 1800 });
    const client = makeClient();
    client._setOpenRows([legacy]);
    await closeUserOpenAuthorizationsForNewSession(client, 'u1', nowMs);
    const upd = client._updates.find((u: any) => u.table === 'conversation_session_authorizations');
    expect(upd.vals.duration_seconds).toBe(120);
  });

  it('does nothing when the user has no open rows', async () => {
    const client = makeClient();
    client._setOpenRows([]);
    expect(await closeUserOpenAuthorizationsForNewSession(client, 'u1', T0 + 1000)).toBe(0);
  });
});
