/**
 * GET /api/listening/story/pending — READ-ONLY auto-recovery of the user's
 * already-prepared (pending) story for today. Must never generate, select,
 * attach, or consume. Handler-level coverage: gating + response shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetEntitlements, mockGetServiceClient, mockGetPending } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetEntitlements: vi.fn(),
  mockGetServiceClient: vi.fn(() => ({})),
  mockGetPending: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({ getCurrentUserPlanEntitlements: mockGetEntitlements }));
vi.mock('../_entitlements/require-feature-access', () => ({ checkFeatureConfigError: () => null }));
vi.mock('../../src/server/product-config', () => ({
  getProductConfig: async () => ({ values: { 'features.listening': { enabled: true, startsAt: null, endsAt: null } } }),
  resolveConfigEnvironment: () => 'production',
  isWithinConfiguredWindow: () => false,
}));
vi.mock('../../src/services/listening/publication/_supabase', () => ({ getListeningServiceClient: mockGetServiceClient }));
vi.mock('../../src/services/listening/shared-story/get-or-create-shared-listening-story', () => ({
  getPendingListeningStoryForToday: mockGetPending,
  getOrCreateSharedListeningStory: vi.fn(),
}));

import handler from '../listening/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000031';

function lim(o: Partial<FeatureLimit> = {}): FeatureLimit {
  return { enabled: true, unlimited: false, limit: 3, consumed: 0, remaining: 3, period: 'day', state: 'available', canStart: true, ...o };
}
function entitlements(enabled = true): PlanEntitlementsSnapshot {
  return {
    planId: 'p', planCode: 'plus', planName: 'Plus', planVersionId: 'v', suspended: false,
    writing: { enabled: true, themeGenerations: lim(), reviews: lim(), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled, stories: lim() },
    pronunciation: { enabled: true, evaluations: lim(), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: lim('month' as never), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null, resolvedAt: new Date().toISOString(),
  };
}

function makeReq(method = 'GET') {
  return { method, headers: { authorization: 'Bearer t' }, query: { slug: 'story/pending' }, url: '/api/listening/story/pending' };
}
function makeRes() {
  let _status = 200; let _body: unknown;
  const res = { _status: () => _status, _body: () => _body, status(s: number) { _status = s; return res; }, json(b: unknown) { _body = b; return res; }, setHeader() {} };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key';
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  mockGetEntitlements.mockResolvedValue(entitlements());
});

describe('GET /api/listening/story/pending', () => {
  const STORY = { sharedStoryId: 's1', title: 'A', level: 'A1', summary: 's', parts: [{}, {}] };

  it('returns the pending story when one exists — without generating or consuming', async () => {
    mockGetPending.mockResolvedValue(STORY);
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).pending).toEqual(STORY);
    expect(mockGetPending).toHaveBeenCalledWith(USER_ID, expect.anything(), 'svc-key');
  });

  it('returns { pending: null } when there is no pending (client falls back to the prompt)', async () => {
    mockGetPending.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).pending).toBeNull();
  });

  it('blocks when listening is disabled by plan (403), never reading a pending', async () => {
    mockGetEntitlements.mockResolvedValue(entitlements(false));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(403);
    expect(mockGetPending).not.toHaveBeenCalled();
  });

  it('rejects a non-GET method', async () => {
    const res = makeRes();
    await handler(makeReq('POST'), res);
    expect(res._status()).toBe(405);
    expect(mockGetPending).not.toHaveBeenCalled();
  });
});
