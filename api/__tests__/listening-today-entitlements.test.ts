import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockGetListeningToday } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockGetListeningToday: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));
vi.mock('../../src/services/listening/daily/get-listening-today', () => ({
  getListeningToday: mockGetListeningToday,
}));

import handler from '../listening/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}
function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

function makeReq() {
  return { method: 'GET', headers: { authorization: 'Bearer test' }, query: { slug: 'today' }, url: '/api/listening/today' };
}
function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader() {},
  };
  return res;
}

function makeChain(result: { data: unknown; error: unknown }) {
  const resolved = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain,
    maybeSingle: () => resolved,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => resolved.then(resolve, reject),
  };
  return chain;
}

describe('GET /api/listening/today — plan entitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: { from: vi.fn(() => makeChain({ data: null, error: null })) },
    });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
    mockGetListeningToday.mockResolvedValue({ status: 'assigned', assignmentId: 'a1', episodeId: 'e1', activityDate: '2026-07-18' });
  });

  it('passes through to getListeningToday when listening is enabled with stories remaining', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockGetListeningToday).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(res._status()).toBe(200);
  });

  it('returns 403 FEATURE_DISABLED and never calls getListeningToday when listening is disabled by plan', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.listening.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockGetListeningToday).not.toHaveBeenCalled();
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
  });

  it('blocks starting a new story once the daily limit is exhausted and no assignment exists yet today', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.listening.stories = { enabled: true, unlimited: false, limit: 1, consumed: 1, remaining: 0, period: 'day', state: 'daily_limit_reached', canStart: false };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: { from: vi.fn(() => makeChain({ data: null, error: null })) }, // no existing assignment today
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockGetListeningToday).not.toHaveBeenCalled();
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
  });

  it('still allows continuing when an assignment already exists today, even at the daily limit', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.listening.stories = { enabled: true, unlimited: false, limit: 1, consumed: 1, remaining: 0, period: 'day', state: 'daily_limit_reached', canStart: false };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: { from: vi.fn(() => makeChain({ data: { id: 'existing-assignment-1' }, error: null })) },
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockGetListeningToday).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });
});
