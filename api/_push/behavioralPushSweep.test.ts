import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// importActual spread in the vi.mock above keeps the real BEHAVIORAL_PUSH constants.
import { BEHAVIORAL_PUSH } from './behavioralPushDomain';
import { DAILY_PRACTICE_COPIES } from './behavioralPushCopy';

function makeClient(rpcHandlers: Record<string, (args: any) => any>) {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    rpc: vi.fn(async (name: string, args: any) => {
      calls.push({ name, args });
      return rpcHandlers[name] ? rpcHandlers[name](args) : { data: null, error: null };
    }),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { interface_language: 'pt-BR' }, error: null }),
        }),
      }),
    }),
  };
}

function candidate(userId: string) {
  return {
    user_id: userId,
    active_weekdays: [0, 1, 2, 3, 4, 5, 6],
    active_dates: ['2026-09-10'],
    practiced_today: false,
    account_created_date: '2026-01-01',
    last_activity_at: '2026-09-10T12:00:00Z',
  };
}
const CANDIDATE = candidate('user-1');

function req() {
  return { method: 'GET', query: { force: '1' } } as any;
}
function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  r.setHeader = vi.fn(() => r);
  return r;
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
  // v2: the sole decision is the daily practice reminder.
  h.decide.mockReturnValue({ pushType: 'practice_reminder_behavioral', streak: 5, missedStudyDays: 0 });
  h.entitlements.mockResolvedValue({
    writing: { enabled: true }, listening: { enabled: false },
    pronunciation: { enabled: false }, conversation: { enabled: false },
  });
  h.canSend.mockResolvedValue(true);
  h.send.mockResolvedValue({ ok: true, notificationId: 'notif-1', failureCode: null });
});

describe('handleBehavioralPushSweep — v2 daily reminder', () => {
  it('real send: claims with the daily rotation copy, revalidates, sends by External ID, marks sent', async () => {
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());

    // Sent individually by external_id (never a broadcast).
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({ externalId: 'user-1', appId: 'app-1', restApiKey: 'key-1' });
    expect(markCalls(h.client, 'sent')).toHaveLength(1);

    // Claim persisted the global daily copy variant + title/body snapshot.
    const claim = callsOf(h.client, 'behavioral_push_claim')[0].args;
    expect(claim.p_push_type).toBe('practice_reminder_behavioral');
    expect(claim.p_copy_variant).toMatch(/^practice_reminder_behavioral\.v1\.\d{2}$/);
    const match = DAILY_PRACTICE_COPIES.find((c) => c.title === claim.p_title_snapshot);
    expect(match).toBeTruthy();
    expect(claim.p_body_snapshot).toBe(match!.body);
    // The push carries exactly the snapshotted copy.
    expect(h.send.mock.calls[0][0]).toMatchObject({ title: claim.p_title_snapshot, body: claim.p_body_snapshot });
  });

  it('candidates queried with the snapshot lookback and NO cooldown param', async () => {
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [], error: null }),
    });
    await handleBehavioralPushSweep(req(), res());
    const cand = callsOf(h.client, 'behavioral_push_candidates')[0].args;
    // Lookback is snapshot-only (streak/last_activity), NOT an eligibility gate.
    expect(cand.p_lookback_days).toBe(BEHAVIORAL_PUSH.SNAPSHOT_LOOKBACK_DAYS);
    // 72h cooldown removed → the sweep no longer sends a cooldown parameter.
    expect(cand.p_cooldown_hours).toBeUndefined();
  });

  it('revalidate no longer receives a cooldown param (only user + local_date)', async () => {
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });
    await handleBehavioralPushSweep(req(), res());
    const reval = callsOf(h.client, 'behavioral_push_revalidate')[0].args;
    expect(reval.p_user_id).toBe('user-1');
    expect(reval).not.toHaveProperty('p_cooldown_hours');
  });

  it('F + L: two eligible users the same day get the EXACT same copy, each targeted by its own External ID', async () => {
    const batch = [candidate('user-1'), candidate('user-2')];
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: batch, error: null }),
      behavioral_push_claim: () => ({ data: 'claim-x', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());

    const claims = callsOf(h.client, 'behavioral_push_claim').map((c: any) => c.args);
    expect(claims).toHaveLength(2);
    // Same copy_variant, title and body for BOTH users on this local_date.
    expect(claims[0].p_copy_variant).toBe(claims[1].p_copy_variant);
    expect(claims[0].p_title_snapshot).toBe(claims[1].p_title_snapshot);
    expect(claims[0].p_body_snapshot).toBe(claims[1].p_body_snapshot);

    // Two individual sends, one per External ID — never a single broadcast.
    expect(h.send).toHaveBeenCalledTimes(2);
    const externalIds = h.send.mock.calls.map((c: any) => c[0].externalId).sort();
    expect(externalIds).toEqual(['user-1', 'user-2']);
    // And both carry the same (global) message.
    expect(h.send.mock.calls[0][0].title).toBe(h.send.mock.calls[1][0].title);
  });

  it('I: force=1 still runs the product gates — entitlement failure blocks the send', async () => {
    // force=1 (see req()) bypasses ONLY the 20:00 SP window. The candidate
    // filtering (practiced_today / active_weekdays / idempotency, all in SQL)
    // and the entitlement check still run. Here entitlement is denied.
    h.entitlements.mockResolvedValue({
      writing: { enabled: false }, listening: { enabled: false },
      pronunciation: { enabled: false }, conversation: { enabled: false },
    });
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    // The eligibility query DID run (gates applied), but no claim/send happened.
    expect(callsOf(h.client, 'behavioral_push_candidates')).toHaveLength(1);
    expect(callsOf(h.client, 'behavioral_push_claim')).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('dry-run mode (flag off): claims + marks dry_run, never calls OneSignal', async () => {
    h.env.enabled = false;
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());

    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'dry_run')).toHaveLength(1);
    expect(markCalls(h.client, 'sent')).toHaveLength(0);
  });

  it('test allowlist: a user not on the list is dry_run, not sent (homolog safety)', async () => {
    h.env.testUserIds = new Set(['someone-else']);
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'dry_run')).toHaveLength(1);
  });

  it('concurrent claim / request retry: claim returns null → no send, no mark (idempotency)', async () => {
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: null, error: null }), // lost the race
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(h.client.calls.some((c: any) => c.name === 'behavioral_push_mark')).toBe(false);
  });

  it('race with a 20:00 completion: revalidation fails → skipped, not sent', async () => {
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: false, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'skipped')).toHaveLength(1);
    expect(markCalls(h.client, 'skipped')[0].args.p_failure_code).toBe('revalidation_failed');
  });

  it('suppressed communication → skipped, not sent', async () => {
    h.canSend.mockResolvedValue(false);
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.send).not.toHaveBeenCalled();
    expect(markCalls(h.client, 'skipped')[0].args.p_failure_code).toBe('communication_blocked');
  });
});
