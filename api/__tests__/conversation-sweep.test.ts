/**
 * Tests for GET /api/internal/listening/conversation-sweep
 * (handleConversationSweep) — Etapa 11 realtime hardening. Closes two
 * classes of orphaned state no cooperative client path can ever reach on
 * its own: ai_provider_sessions abandoned (heartbeat gone stale, or never
 * activated past its authorization window) and
 * conversation_session_authorizations abandoned past their grace window.
 *
 * hangupAndPersist itself is mocked here — its own real-OpenAI-call
 * behavior has full coverage in api/__tests__/realtime-hangup.test.ts; this
 * file only asserts that the sweep calls it for the right rows, with the
 * right arguments, and correctly transitions/mirrors state around it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCheckCronAuth, mockHangupAndPersist, mockFrom,
  mockReconcileSessionReservation, mockReleaseSessionReservation, mockGetProductionDeps,
  mockReleaseExpiredPendingReservations,
} = vi.hoisted(() => ({
  mockCheckCronAuth: vi.fn(),
  mockHangupAndPersist: vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 }),
  mockFrom: vi.fn(),
  mockReconcileSessionReservation: vi.fn().mockResolvedValue(undefined),
  mockReleaseSessionReservation: vi.fn().mockResolvedValue(undefined),
  mockReleaseExpiredPendingReservations: vi.fn().mockResolvedValue({ releasedCount: 0 }),
  // Never actually used by reconcileSessionReservation/releaseSessionReservation
  // themselves (both fully mocked below) — just needs to exist so
  // getProductionDeps() doesn't try to construct real Supabase clients
  // (which would throw without real service-role credentials) purely to be
  // passed through as an opaque first argument.
  mockGetProductionDeps: vi.fn(() => ({}) as any),
}));

vi.mock('../internal/_auth', () => ({ checkCronAuth: mockCheckCronAuth }));
vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return {
    ...actual,
    getSharedServiceClient: () => ({ from: mockFrom }),
    getProductionDeps: mockGetProductionDeps,
    reconcileSessionReservation: mockReconcileSessionReservation,
    releaseSessionReservation: mockReleaseSessionReservation,
    releaseExpiredPendingReservations: mockReleaseExpiredPendingReservations,
  };
});
vi.mock('../_realtime-hangup', () => ({ hangupAndPersist: mockHangupAndPersist }));

import handler from '../internal/listening/[...slug]';

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/internal/listening/conversation-sweep', headers: { authorization: 'Bearer cron-secret' }, ...overrides };
}
function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader: vi.fn(),
  };
  return res;
}

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'not', 'lt', 'update', 'insert']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

// Queues one chain per call to .from(table), consumed strictly in call
// order — the handler's own code determines that order, mirrored 1:1 here
// per test.
function queueFrom(perTableChains: Record<string, ReturnType<typeof makeChain>[]>) {
  const cursors: Record<string, number> = {};
  mockFrom.mockImplementation((table: string) => {
    const i = (cursors[table] ??= 0);
    cursors[table] = i + 1;
    const chains = perTableChains[table] ?? [];
    return chains[i] ?? makeChain({ data: null, error: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckCronAuth.mockReturnValue(true);
  mockHangupAndPersist.mockResolvedValue({ ok: true, httpStatus: 200 });
  mockReleaseExpiredPendingReservations.mockResolvedValue({ releasedCount: 0 });
});

describe('GET /conversation-sweep — ai_provider_sessions, heartbeat-stale active', () => {
  it('closes an active session whose heartbeat has gone stale, real-hangs-up using its captured call_id', async () => {
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [{ id: 'sess-1', provider_session_id: 'call_abc', started_at: new Date(Date.now() - 300_000).toISOString() }], error: null }), // staleActive
        makeChain({ data: null, error: null }), // closeStaleProviderSession's UPDATE
        makeChain({ data: [], error: null }), // staleAuthorized (none)
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockHangupAndPersist).toHaveBeenCalledWith('sess-1', 'call_abc');
    expect(res._status()).toBe(200);
    expect((res._body() as any).expiredSessions).toBe(1);
  });

  it('never calls hangupAndPersist when no call_id was ever captured — still closes the session', async () => {
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [{ id: 'sess-1', provider_session_id: null, started_at: new Date().toISOString() }], error: null }),
        makeChain({ data: null, error: null }),
        makeChain({ data: [], error: null }),
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    await handler(makeReq(), makeRes());
    expect(mockHangupAndPersist).not.toHaveBeenCalled();
  });

  it('the closing UPDATE is guarded by current status — only transitions active/authorized/connecting, never a row another path already closed', async () => {
    const updateChain = makeChain({ data: null, error: null });
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [{ id: 'sess-1', provider_session_id: null, started_at: new Date().toISOString() }], error: null }),
        updateChain,
        makeChain({ data: [], error: null }),
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    await handler(makeReq(), makeRes());
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(updateChain.in).toHaveBeenCalledWith('status', ['active', 'authorized', 'connecting']);
  });
});

describe('GET /conversation-sweep — ai_provider_sessions, never-activated past authorization window', () => {
  it('closes an authorized/connecting session past authorization_expires_at', async () => {
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [], error: null }), // staleActive (none)
        makeChain({ data: [{ id: 'sess-2', provider_session_id: null, started_at: null }], error: null }), // staleAuthorized
        makeChain({ data: null, error: null }), // its UPDATE
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body() as any).expiredSessions).toBe(1);
  });
});

describe('GET /conversation-sweep — conversation_session_authorizations abandoned past grace', () => {
  const AUTHORIZED_AT = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
  const MAX_SECONDS = 120;

  it('closes a row past authorized_at + authorized_max_seconds + grace, clamps duration to authorized_max_seconds, mirrors into conversation_sessions', async () => {
    const updateChain = makeChain({ data: { id: 'auth-1' }, error: null });
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{ id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: AUTHORIZED_AT, authorized_max_seconds: MAX_SECONDS }],
          error: null,
        }),
        updateChain,
      ],
      conversation_sessions: [makeChain({ data: null, error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', duration_seconds: MAX_SECONDS }));
    expect(mockFrom).toHaveBeenCalledWith('conversation_sessions');
    expect((res._body() as any).closedAuthorizations).toBe(1);
  });

  it('a row still within its grace window (DB filter was a safe superset) is left untouched — no UPDATE issued', async () => {
    const recentAuthorizedAt = new Date(Date.now() - 10_000).toISOString(); // 10s ago — well within any grace
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{ id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: recentAuthorizedAt, authorized_max_seconds: MAX_SECONDS }],
          error: null,
        }),
      ],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body() as any).closedAuthorizations).toBe(0);
  });

  it('idempotent — a row another path (or a concurrent sweep tick) already closed first (UPDATE matches 0 rows) is not double-counted or mirrored', async () => {
    const updateChain = makeChain({ data: null, error: null }); // .maybeSingle() → no row matched
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{ id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: AUTHORIZED_AT, authorized_max_seconds: MAX_SECONDS }],
          error: null,
        }),
        updateChain,
      ],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body() as any).closedAuthorizations).toBe(0);
    expect(mockFrom).not.toHaveBeenCalledWith('conversation_sessions');
  });

  // ── Reconciling an abandoned session's upfront budget reservation ────────
  // Requirement 7 ("safe expiration/finalization strategy"): an incomplete
  // session must never permanently return budget for cost that already
  // happened. The sweep now reconciles (commits real cost, or releases in
  // full if truly nothing was consumed) instead of leaving the reservation
  // dangling forever.

  it('reconciles the linked gateway_budget_reservation_id (commit/release real cost) using gateway_session_id', async () => {
    const updateChain = makeChain({ data: { id: 'auth-1' }, error: null });
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{
            id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: AUTHORIZED_AT, authorized_max_seconds: MAX_SECONDS,
            gateway_budget_reservation_id: 'reservation-abandoned-1', gateway_session_id: 'gw-session-abandoned-1',
          }],
          error: null,
        }),
        updateChain,
      ],
      conversation_sessions: [makeChain({ data: null, error: null })],
    });

    await handler(makeReq(), makeRes());
    expect(mockReconcileSessionReservation).toHaveBeenCalledWith(
      expect.anything(), 'conversation.realtime_usage', 'reservation-abandoned-1', 'gw-session-abandoned-1',
    );
    expect(mockReleaseSessionReservation).not.toHaveBeenCalled();
  });

  it('releases (never reconciles) when the row has a reservation id but no gateway_session_id', async () => {
    const updateChain = makeChain({ data: { id: 'auth-1' }, error: null });
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{
            id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: AUTHORIZED_AT, authorized_max_seconds: MAX_SECONDS,
            gateway_budget_reservation_id: 'reservation-abandoned-2', gateway_session_id: null,
          }],
          error: null,
        }),
        updateChain,
      ],
      conversation_sessions: [makeChain({ data: null, error: null })],
    });

    await handler(makeReq(), makeRes());
    expect(mockReleaseSessionReservation).toHaveBeenCalledWith(expect.anything(), 'reservation-abandoned-2', 'no_gateway_session_to_reconcile_against');
    expect(mockReconcileSessionReservation).not.toHaveBeenCalled();
  });

  it('never attempts reconciliation when the row has no gateway_budget_reservation_id (no budget was configured at session-start)', async () => {
    const updateChain = makeChain({ data: { id: 'auth-1' }, error: null });
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{
            id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: AUTHORIZED_AT, authorized_max_seconds: MAX_SECONDS,
            gateway_budget_reservation_id: null, gateway_session_id: null,
          }],
          error: null,
        }),
        updateChain,
      ],
      conversation_sessions: [makeChain({ data: null, error: null })],
    });

    await handler(makeReq(), makeRes());
    expect(mockReconcileSessionReservation).not.toHaveBeenCalled();
    expect(mockReleaseSessionReservation).not.toHaveBeenCalled();
  });

  it('a reconciliation failure never blocks the sweep response (best-effort, logged)', async () => {
    mockReconcileSessionReservation.mockRejectedValueOnce(new Error('rpc down'));
    const updateChain = makeChain({ data: { id: 'auth-1' }, error: null });
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [
        makeChain({
          data: [{
            id: 'auth-1', user_id: 'user-1', session_date: '2026-07-20', authorized_at: AUTHORIZED_AT, authorized_max_seconds: MAX_SECONDS,
            gateway_budget_reservation_id: 'reservation-abandoned-3', gateway_session_id: 'gw-session-abandoned-3',
          }],
          error: null,
        }),
        updateChain,
      ],
      conversation_sessions: [makeChain({ data: null, error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).closedAuthorizations).toBe(1);
  });
});

describe('GET /conversation-sweep — pronunciation.assess_text abandoned ai_provider_sessions', () => {
  it('a session past its authorization window with no reservation id is closed without any reconciliation attempt', async () => {
    const updateChain = makeChain({ data: { id: 'assess-sess-1' }, error: null });
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [], error: null }), // staleActive (none)
        makeChain({ data: [], error: null }), // staleAuthorized (none)
        makeChain({ data: [{ id: 'assess-sess-1', metadata: {} }], error: null }), // staleAssessText
        updateChain,
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(updateChain.in).toHaveBeenCalledWith('status', ['authorized', 'connecting', 'active']);
    expect((res._body() as any).expiredAssessTextSessions).toBe(1);
    expect(mockReconcileSessionReservation).not.toHaveBeenCalled();
    expect(mockReleaseSessionReservation).not.toHaveBeenCalled();
  });

  it('a session without real usage (never reached /complete) has its reservation released via reconcileSessionReservation', async () => {
    const updateChain = makeChain({ data: { id: 'assess-sess-2' }, error: null });
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [], error: null }),
        makeChain({ data: [], error: null }),
        makeChain({ data: [{ id: 'assess-sess-2', metadata: { gatewayBudgetReservationId: 'reservation-abandoned-4' } }], error: null }),
        updateChain,
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    await handler(makeReq(), makeRes());

    // reconcileSessionReservation itself decides release-vs-commit based on
    // real usage events (see reservation-reconciliation.test.ts) — the sweep
    // only has to call it with the right feature key, reservation id, and
    // session id (used as providerSessionRecordId, matching how
    // recordAssessTextUsageEvent keyed the session's real events).
    expect(mockReconcileSessionReservation).toHaveBeenCalledWith(
      expect.anything(), 'pronunciation.assess_text', 'reservation-abandoned-4', 'assess-sess-2',
    );
  });

  it('idempotent — a row another path already closed first (UPDATE matches 0 rows) is not double-counted or reconciled', async () => {
    const updateChain = makeChain({ data: null, error: null }); // .maybeSingle() → no row matched
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [], error: null }),
        makeChain({ data: [], error: null }),
        makeChain({ data: [{ id: 'assess-sess-3', metadata: { gatewayBudgetReservationId: 'reservation-abandoned-5' } }], error: null }),
        updateChain,
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body() as any).expiredAssessTextSessions).toBe(1); // the sweep still attempted it...
    expect(mockReconcileSessionReservation).not.toHaveBeenCalled(); // ...but the guarded UPDATE matched nothing, so no reconciliation ran
  });

  it('a reconciliation failure never blocks the sweep response (best-effort, logged)', async () => {
    mockReconcileSessionReservation.mockRejectedValueOnce(new Error('rpc down'));
    const updateChain = makeChain({ data: { id: 'assess-sess-4' }, error: null });
    queueFrom({
      ai_provider_sessions: [
        makeChain({ data: [], error: null }),
        makeChain({ data: [], error: null }),
        makeChain({ data: [{ id: 'assess-sess-4', metadata: { gatewayBudgetReservationId: 'reservation-abandoned-6' } }], error: null }),
        updateChain,
      ],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).expiredAssessTextSessions).toBe(1);
  });
});

describe('GET /conversation-sweep — generic expired-reservation release (other features)', () => {
  it('calls releaseExpiredPendingReservations with the sweep\'s own "now" and surfaces its count in the response', async () => {
    mockReleaseExpiredPendingReservations.mockResolvedValue({ releasedCount: 2 });
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockReleaseExpiredPendingReservations).toHaveBeenCalledWith(expect.anything(), expect.any(String));
    expect((res._body() as any).releasedExpiredReservations).toBe(2);
  });

  it('a failure never blocks the sweep response (best-effort, logged)', async () => {
    mockReleaseExpiredPendingReservations.mockRejectedValue(new Error('rpc down'));
    queueFrom({
      ai_provider_sessions: [makeChain({ data: [], error: null }), makeChain({ data: [], error: null }), makeChain({ data: [], error: null })],
      conversation_session_authorizations: [makeChain({ data: [], error: null })],
    });

    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).releasedExpiredReservations).toBe(0);
  });
});

describe('GET /conversation-sweep — auth and method', () => {
  it('rejects without valid cron auth', async () => {
    mockCheckCronAuth.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a non-GET method', async () => {
    queueFrom({});
    const res = makeRes();
    await handler(makeReq({ method: 'POST' }), res);
    expect(res._status()).toBe(405);
  });
});
