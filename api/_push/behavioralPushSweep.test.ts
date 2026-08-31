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

const CANDIDATE = {
  user_id: 'user-1',
  active_weekdays: [0, 1, 2, 3, 4, 5, 6],
  active_dates: ['2026-09-10'],
  practiced_today: false,
  account_created_date: '2026-01-01',
  last_activity_at: '2026-09-10T12:00:00Z',
};

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

function markCalls(client: any, status: string) {
  return client.calls.filter((c: any) => c.name === 'behavioral_push_mark' && c.args.p_status === status);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.env = { enabled: true, dryRun: false, testUserIds: new Set(), appId: 'app-1', restKey: 'key-1' };
  h.decide.mockReturnValue({ pushType: 'streak_risk', streak: 5, missedStudyDays: 0 });
  h.entitlements.mockResolvedValue({
    writing: { enabled: true }, listening: { enabled: false },
    pronunciation: { enabled: false }, conversation: { enabled: false },
  });
  h.canSend.mockResolvedValue(true);
  h.send.mockResolvedValue({ ok: true, notificationId: 'notif-1', failureCode: null });
});

describe('handleBehavioralPushSweep', () => {
  it('real send: claims, revalidates, sends by External ID, marks sent', async () => {
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
      behavioral_push_revalidate: () => ({ data: true, error: null }),
      behavioral_push_mark: () => ({ data: true, error: null }),
    });

    const r = res();
    await handleBehavioralPushSweep(req(), r);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({ externalId: 'user-1', appId: 'app-1', restApiKey: 'key-1' });
    expect(markCalls(h.client, 'sent')).toHaveLength(1);
    expect(markCalls(h.client, 'sent')[0].args.p_onesignal_notification_id).toBe('notif-1');
    // candidates queried with the 72h cooldown window.
    const cand = h.client.calls.find((c: any) => c.name === 'behavioral_push_candidates');
    expect(cand.args.p_cooldown_hours).toBe(72);
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

  it('test allowlist: a user not on the list is dry_run, not sent', async () => {
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
    // Non-production: the allowlist is passed as the account-exclusion bypass.
    const cand = h.client.calls.find((c: any) => c.name === 'behavioral_push_candidates');
    expect(cand.args.p_bypass_user_ids).toEqual(['someone-else']);
  });

  it('concurrent claim / request retry: claim returns null → no send, no mark', async () => {
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

  it('no accessible practice modality → skip entirely (no claim)', async () => {
    h.entitlements.mockResolvedValue({
      writing: { enabled: false }, listening: { enabled: false },
      pronunciation: { enabled: false }, conversation: { enabled: false },
    });
    h.client = makeClient({
      behavioral_push_candidates: () => ({ data: [CANDIDATE], error: null }),
      behavioral_push_claim: () => ({ data: 'claim-1', error: null }),
    });

    await handleBehavioralPushSweep(req(), res());
    expect(h.client.calls.some((c: any) => c.name === 'behavioral_push_claim')).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
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
