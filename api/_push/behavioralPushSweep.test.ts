import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  client: null as any,
  decide: vi.fn(),
  send: vi.fn(),
  entitlements: vi.fn(),
  canSend: vi.fn(),
  env: {
    enabled: true,
    dryRun: false,
    testUserIds: new Set<string>(),
    appId: 'app-1',
    restKey: 'key-1',
  },
}));

vi.mock('../_ai-gateway/index', () => ({
  getSharedServiceClient: () => h.client,
}));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: (...a: unknown[]) => h.entitlements(...a),
}));
vi.mock('../_account/communication-suppression', () => ({
  canSendCommunication: (...a: unknown[]) => h.canSend(...a),
}));
vi.mock('./oneSignalServer', () => ({
  sendBehavioralPush: (...a: unknown[]) => h.send(...a),
}));
vi.mock('../_env', () => ({
  isBehavioralPushEnabled: () => h.env.enabled,
  isBehavioralPushDryRun: () => h.env.dryRun,
  getBehavioralPushTestUserIds: () => h.env.testUserIds,
  getBehavioralPushEnvironment: () => 'test',
  getOneSignalServerAppId: () => h.env.appId,
  getOneSignalRestApiKey: () => h.env.restKey,
}));
vi.mock('./behavioralPushDomain', async (importActual) => {
  const actual = await importActual<typeof import('./behavioralPushDomain')>();
  return { ...actual, decideBehavioralPush: (...a: unknown[]) => h.decide(...a) };
});

import { handleBehavioralPushSweep } from './behavioralPushSweep';
import { BEHAVIORAL_PUSH } from './behavioralPushDomain';
import { DAILY_PRACTICE_COPIES } from './behavioralPushCopy';

/** A minimal fake client whose `behavioral_push_candidates` honours keyset
 *  pagination (p_after_user_id + p_limit) and excludes anyone already claimed —
 *  exactly like the real SQL pre-filter + UNIQUE(user_id, local_date). The claim
 *  handler records claimed ids so a re-query naturally skips them (idempotency).
 */
function makeWorld(userIds: string[]) {
  const claimed = new Set<string>();
  const calls: Array<{ name: string; args: any }> = [];
  const client = {
    calls,
    claimed,
    rpc: vi.fn(async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'behavioral_push_candidates') {
        const after = args.p_after_user_id as string | null;
        const limit = args.p_limit as number;
        const pool = userIds
          .filter((id) => !claimed.has(id) && (after == null || id > after))
          .sort();
        const rows = pool.slice(0, limit).map((id) => ({
          user_id: id,
          active_weekdays: [0, 1, 2, 3, 4, 5, 6],
          active_dates: [] as string[],
          practiced_today: false,
          account_created_date: '2020-01-01',
          last_activity_at: null,
        }));
        return { data: rows, error: null };
      }
      if (name === 'behavioral_push_claim') {
        const id = args.p_user_id as string;
        if (claimed.has(id)) return { data: null, error: null }; // already decided today
        claimed.add(id);
        return { data: `claim-${id}`, error: null };
      }
      if (name === 'behavioral_push_revalidate') return { data: true, error: null };
      if (name === 'behavioral_push_mark') return { data: true, error: null };
      return { data: null, error: null };
    }),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { interface_language: 'pt-BR' }, error: null }) }) }),
    }),
  };
  return client;
}

/** Simple client for the single-candidate behavioural tests. */
function makeClient(rpcHandlers: Record<string, (args: any) => any>) {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    rpc: vi.fn(async (name: string, args: any) => {
      calls.push({ name, args });
      return rpcHandlers[name] ? rpcHandlers[name](args) : { data: null, error: null };
    }),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { interface_language: 'pt-BR' }, error: null }) }) }),
    }),
  };
}

const CANDIDATE = {
  user_id: 'user-1',
  active_weekdays: [0, 1, 2, 3, 4, 5, 6],
  active_dates: ['2026-09-10'],
  practiced_today: false,
  account_created_date: '2026-01-01',
  last_activity_at: '2026-09-10T12:00:00Z',
};

/** Zero-padded, lexicographically sortable ids so keyset order is deterministic. */
function ids(n: number, offset = 0): string[] {
  return Array.from({ length: n }, (_, i) => `user-${String(offset + i + 1).padStart(6, '0')}`);
}

function req(query: Record<string, string> = {}) {
  return { method: 'GET', query: { force: '1', ...query } } as any;
}
function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  r.setHeader = vi.fn(() => r);
  return r;
}
function payload(r: any) {
  return r.json.mock.calls[r.json.mock.calls.length - 1][0];
}
function callsOf(client: any, name: string) {
  return client.calls.filter((c: any) => c.name === name);
}
function markCalls(client: any, status: string) {
  return client.calls.filter((c: any) => c.name === 'behavioral_push_mark' && c.args.p_status === status);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env = { enabled: true, dryRun: false, testUserIds: new Set(), appId: 'app-1', restKey: 'key-1' };
  h.decide.mockReturnValue({ pushType: 'practice_reminder_behavioral', streak: 0, missedStudyDays: 0 });
  h.entitlements.mockResolvedValue({
    writing: { enabled: true }, listening: { enabled: false },
    pronunciation: { enabled: false }, conversation: { enabled: false },
  });
  h.canSend.mockResolvedValue(true);
  h.send.mockResolvedValue({ ok: true, notificationId: 'notif-1', failureCode: null });
});
afterEach(() => vi.restoreAllMocks());

describe('handleBehavioralPushSweep — scalability (keyset + time budget + drain)', () => {
  it('A + B + C + E: >1000 eligible users are ALL processed across many keyset pages, each once, with the same copy', async () => {
    const N = 1200; // > the old fixed 1000 cap
    h.client = makeWorld(ids(N));

    const r = res();
    await handleBehavioralPushSweep(req(), r);
    const body = payload(r);

    // A: none silently dropped — every eligible user processed & sent.
    expect(body.processed).toBe(N);
    expect(body.sent).toBe(N);
    expect(body.claimed).toBe(N);
    // B: multiple keyset pages (1200 / 100 = 12).
    expect(body.batches).toBe(Math.ceil(N / BEHAVIORAL_PUSH.SWEEP_BATCH_SIZE));
    // G: drained → no more, no cursor.
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();

    // C: no user claimed/sent twice.
    const claimIds = callsOf(h.client, 'behavioral_push_claim').map((c: any) => c.args.p_user_id);
    expect(claimIds.length).toBe(N);
    expect(new Set(claimIds).size).toBe(N);
    const sentIds = h.send.mock.calls.map((c: any) => c[0].externalId);
    expect(new Set(sentIds).size).toBe(N);

    // Keyset advanced (never OFFSET): candidates queried with p_after_user_id,
    // never p_offset.
    const candCalls = callsOf(h.client, 'behavioral_push_candidates');
    expect(candCalls[0].args.p_after_user_id).toBeNull();
    expect(candCalls[1].args.p_after_user_id).toBe('user-000100'); // last id of page 1
    expect(candCalls.every((c: any) => !('p_offset' in c.args))).toBe(true);

    // E: identical copy for every claim (one voice per local_date).
    const claims = callsOf(h.client, 'behavioral_push_claim').map((c: any) => c.args);
    const v0 = claims[0].p_copy_variant;
    expect(claims.every((c: any) => c.p_copy_variant === v0)).toBe(true);
    expect(new Set(claims.map((c: any) => c.p_title_snapshot)).size).toBe(1);
    expect(new Set(claims.map((c: any) => c.p_body_snapshot)).size).toBe(1);
    const match = DAILY_PRACTICE_COPIES.find((c) => c.title === claims[0].p_title_snapshot);
    expect(match).toBeTruthy();
  });

  it('D: hitting the time budget stops cleanly (hasMore + nextCursor); resuming does NOT duplicate', async () => {
    // Stub the wall clock so the budget trips right after the FIRST full page.
    // Call sequence per invocation: #1 startedAt, #2 pre-batch(0),
    // #3..#(2+BATCH) one per candidate, then #(3+BATCH) pre-batch(1) → trip.
    const world = makeWorld(ids(250));
    h.client = world;
    const underBudgetCalls = 2 + BEHAVIORAL_PUSH.SWEEP_BATCH_SIZE;
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() =>
      ++nowCalls <= underBudgetCalls ? 1000 : 1000 + BEHAVIORAL_PUSH.SWEEP_TIME_BUDGET_MS + 1,
    );

    const r1 = res();
    await handleBehavioralPushSweep(req(), r1);
    const b1 = payload(r1);

    expect(b1.processed).toBe(BEHAVIORAL_PUSH.SWEEP_BATCH_SIZE); // one page only
    expect(b1.batches).toBe(1);
    expect(b1.hasMore).toBe(true);
    expect(b1.nextCursor).toBe(`user-${String(BEHAVIORAL_PUSH.SWEEP_BATCH_SIZE).padStart(6, '0')}`);
    const firstPageClaims = new Set(world.claimed);
    expect(firstPageClaims.size).toBe(BEHAVIORAL_PUSH.SWEEP_BATCH_SIZE);
    const claimCallsAfterRun1 = callsOf(world, 'behavioral_push_claim').length;

    // Resume with the real clock, continuing from the cursor. Same `world`, so
    // its claim handler already holds page 1 — proving idempotent, non-duplicating
    // resumption (both the keyset cursor AND the claimed-set exclude page 1).
    nowSpy.mockRestore();
    const r2 = res();
    await handleBehavioralPushSweep(req({ after: b1.nextCursor }), r2);
    const b2 = payload(r2);

    expect(b2.hasMore).toBe(false);
    expect(world.claimed.size).toBe(250); // 100 + 150, no overlap
    // Claims made during run 2 only (calls array is cumulative across runs).
    const run2ClaimCount = callsOf(world, 'behavioral_push_claim').length - claimCallsAfterRun1;
    expect(run2ClaimCount).toBe(150);
    // Every newly-claimed id is strictly greater than the resume cursor.
    const newlyClaimed = [...world.claimed].filter((id) => !firstPageClaims.has(id));
    expect(newlyClaimed).toHaveLength(150);
    expect(newlyClaimed.every((id) => id > b1.nextCursor)).toBe(true);
  });

  it('G: when there are no more candidates, hasMore=false and nextCursor=null', async () => {
    h.client = makeWorld(ids(5));
    const r = res();
    await handleBehavioralPushSweep(req(), r);
    const body = payload(r);
    expect(body.processed).toBe(5);
    expect(body.batches).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });
});

describe('handleBehavioralPushSweep — behaviour (unchanged rules)', () => {
  it('real send: claims with the daily rotation copy, sends by External ID, marks sent', async () => {
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    const r = res();
    await handleBehavioralPushSweep(req(), r);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({ externalId: 'user-1', appId: 'app-1', restApiKey: 'key-1' });
    expect(markCalls(h.client, 'sent')).toHaveLength(1);

    const claim = callsOf(h.client, 'behavioral_push_claim')[0].args;
    expect(claim.p_push_type).toBe('practice_reminder_behavioral');
    expect(claim.p_copy_variant).toMatch(/^practice_reminder_behavioral\.v1\.\d{2}$/);
    const match = DAILY_PRACTICE_COPIES.find((c) => c.title === claim.p_title_snapshot);
    expect(match).toBeTruthy();
    expect(claim.p_body_snapshot).toBe(match!.body);
    expect(h.send.mock.calls[0][0]).toMatchObject({ title: claim.p_title_snapshot, body: claim.p_body_snapshot });
  });

  it('candidates queried with keyset (p_after_user_id), snapshot lookback, and NO offset/cooldown', async () => {
    h.client = makeClient({ behavioral_push_candidates: () => ({ data: [], error: null }) });
    await handleBehavioralPushSweep(req(), res());
    const cand = callsOf(h.client, 'behavioral_push_candidates')[0].args;
    expect(cand.p_lookback_days).toBe(BEHAVIORAL_PUSH.SNAPSHOT_LOOKBACK_DAYS);
    expect(cand.p_after_user_id).toBeNull();
    expect(cand).not.toHaveProperty('p_offset');
    expect(cand).not.toHaveProperty('p_cooldown_hours');
  });

  it('I: attribution not regressed — a sent push stamps the 24h attribution window', async () => {
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });
    await handleBehavioralPushSweep(req(), res());
    const sent = markCalls(h.client, 'sent')[0].args;
    expect(sent.p_attribution_hours).toBe(BEHAVIORAL_PUSH.ATTRIBUTION_WINDOW_HOURS);
    expect(sent.p_onesignal_notification_id).toBe('notif-1');
  });

  it('H: force=1 still runs the product gates — entitlement failure blocks the send', async () => {
    h.entitlements.mockResolvedValue({
      writing: { enabled: false }, listening: { enabled: false },
      pronunciation: { enabled: false }, conversation: { enabled: false },
    });
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(callsOf(h.client, 'behavioral_push_candidates').length).toBeGreaterThanOrEqual(1);
    expect(callsOf(h.client, 'behavioral_push_claim')).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('dry-run mode (flag off): claims + marks dry_run, never calls OneSignal', async () => {
    h.env.enabled = false;
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'dry_run')).toHaveLength(1);
  });

  it('test allowlist: a user not on the list is dry_run, not sent (homolog safety)', async () => {
    h.env.testUserIds = new Set(['someone-else']);
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'dry_run')).toHaveLength(1);
  });

  it('concurrent claim / retry: claim returns null → no send, no mark (idempotency)', async () => {
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: null, error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(h.client.calls.some((c: any) => c.name === 'behavioral_push_mark')).toBe(false);
  });

  it('race with a completion: revalidation fails → skipped, not sent', async () => {
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: false, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'skipped')[0].args.p_failure_code).toBe('revalidation_failed');
  });

  it('suppressed communication → skipped, not sent', async () => {
    h.canSend.mockResolvedValue(false);
    h.client = makeClient({
      behavioral_push_candidates: (a: any) => ({ data: a.p_after_user_id ? [] : [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'skipped')[0].args.p_failure_code).toBe('communication_blocked');
  });
});
