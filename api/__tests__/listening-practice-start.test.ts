/**
 * POST /api/listening/story/practice-start — consumes ONE story from the daily
 * quota at the first practice action, via consume_listening_pending_story.
 * Handler-level coverage: request validation, entitlement gating, and
 * RPC-response-to-HTTP mapping. The RPC's atomic pending→consumed transition,
 * idempotency, one-pending index and limit re-check are proven against the real
 * homolog schema separately (rolled-back transactional test during this task).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockRpc } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockRpc: vi.fn(),
}));

// consume_listening_pending_story is service_role-only and now runs via
// getListeningServiceClient().rpc(...). Point that client at the SAME hoisted
// rpc spy (mockRpc) so the existing `expect(mockRpc)...` assertions keep working.
vi.mock('../../src/services/listening/publication/_supabase', () => ({
  getListeningServiceClient: vi.fn(() => ({ rpc: mockRpc })),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));
vi.mock('../_entitlements/require-feature-access', () => ({
  checkFeatureConfigError: () => null,
}));
vi.mock('../../src/server/product-config', () => ({
  getProductConfig: async () => ({ values: { 'features.listening': { enabled: true, startsAt: null, endsAt: null } } }),
  resolveConfigEnvironment: () => 'production',
  isWithinConfiguredWindow: () => false,
}));

import handler from '../listening/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const STORY_ID = 'cccccccc-0000-0000-0000-000000000009';

function limit(overrides: Partial<FeatureLimit> = {}): FeatureLimit {
  return { enabled: true, unlimited: false, limit: 3, consumed: 0, remaining: 3, period: 'day', state: 'available', canStart: true, ...overrides };
}
function entitlements(stories: FeatureLimit, enabled = true): PlanEntitlementsSnapshot {
  return {
    planId: 'p', planCode: 'plus', planName: 'Plus', planVersionId: 'v', suspended: false,
    writing: { enabled: true, themeGenerations: limit(), reviews: limit(), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled, stories },
    pronunciation: { enabled: true, evaluations: limit(), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: limit('month' as never), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

function makeReq(body: Record<string, unknown>) {
  return { method: 'POST', headers: { authorization: 'Bearer t' }, query: { slug: 'story/practice-start' }, url: '/api/listening/story/practice-start', body };
}
function makeRes() {
  let _status = 200; let _body: unknown;
  const res = { _status: () => _status, _body: () => _body, status(s: number) { _status = s; return res; }, json(b: unknown) { _body = b; return res; }, setHeader() {} };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: { rpc: mockRpc } });
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements(limit()));
});

describe('POST /api/listening/story/practice-start', () => {
  it('consumes one story and returns the backend-authoritative remaining', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'consumed', consumed: 1 }, error: null });
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_ID }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).action).toBe('consumed');
    expect((res._body() as any).consumed).toBe(1);
    expect((res._body() as any).limit).toBe(3);
    expect((res._body() as any).remaining).toBe(2);
    expect(mockRpc).toHaveBeenCalledWith('consume_listening_pending_story', expect.objectContaining({
      p_user_id: USER_ID, p_shared_story_id: STORY_ID, p_effective_limit: 3, p_unlimited: false,
    }));
  });

  it('is idempotent: already_consumed keeps the same count and returns 200', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'already_consumed', consumed: 1 }, error: null });
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_ID }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).action).toBe('already_consumed');
    expect((res._body() as any).consumed).toBe(1);
  });

  it('unlimited plan reports remaining=null (no numeric cap)', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements(limit({ unlimited: true, limit: 0, remaining: Number.POSITIVE_INFINITY, state: 'unlimited' })));
    mockRpc.mockResolvedValue({ data: { action: 'consumed', consumed: 5 }, error: null });
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_ID }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).unlimited).toBe(true);
    expect((res._body() as any).remaining).toBeNull();
    expect(mockRpc).toHaveBeenCalledWith('consume_listening_pending_story', expect.objectContaining({ p_unlimited: true }));
  });

  it('maps NOT_PREPARED to 409 (never consumes a story the user did not prepare)', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'NOT_PREPARED' }, error: null });
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_ID }), res);

    expect(res._status()).toBe(409);
    expect((res._body() as any).code).toBe('NOT_PREPARED');
  });

  it('maps DAILY_LIMIT_REACHED to 403', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'DAILY_LIMIT_REACHED', consumed: 3 }, error: null });
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_ID }), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
  });

  it('rejects a missing/invalid sharedStoryId with 400 before touching the RPC', async () => {
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: 'not-a-uuid' }), res);

    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_STORY_ID');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('blocks when listening is disabled by plan (403), never consuming', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements(limit(), false));
    const res = makeRes();
    await handler(makeReq({ sharedStoryId: STORY_ID }), res);

    expect(res._status()).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
