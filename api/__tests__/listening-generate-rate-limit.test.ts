/**
 * Audit §18 — a rate-limit block on the listening generation entry points must
 * stop the request BEFORE any OpenAI/Azure call. Proves providerCall.mock.calls
 * is empty on block, and that the limit is actually consulted (with the right
 * key) when the request is allowed through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const {
  mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockApplyRateLimit,
  mockGenerateStorySession, mockGetOrCreateSharedListeningStory, mockGetListeningServiceClient,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockApplyRateLimit: vi.fn(),
  mockGenerateStorySession: vi.fn(),
  mockGetOrCreateSharedListeningStory: vi.fn(),
  mockGetListeningServiceClient: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit, RATE_LIMITS: {} }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({ getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements }));
vi.mock('../../src/services/listening/story-session/generate-story-session', () => ({
  generateStorySession: mockGenerateStorySession,
  decodeAnswerToken: vi.fn(),
}));
vi.mock('../../src/services/listening/shared-story/get-or-create-shared-listening-story', () => ({
  getOrCreateSharedListeningStory: mockGetOrCreateSharedListeningStory,
  getPendingListeningStoryForToday: vi.fn(),
}));
vi.mock('../../src/services/listening/publication/_supabase', () => ({ getListeningServiceClient: mockGetListeningServiceClient }));

import handler from '../listening/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function permissiveLimit(): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period: 'day', state: 'unlimited', canStart: true };
}
function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit(), reviews: permissiveLimit(), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit() },
    pronunciation: { enabled: true, evaluations: permissiveLimit(), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit(), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null, resolvedAt: new Date().toISOString(),
  };
}

function makeReq(slug: string[]) {
  return { method: 'POST', headers: { authorization: 'Bearer test' }, query: { slug }, url: `/api/listening/${slug.join('/')}`, body: {} };
}
function makeRes() {
  let _status = 200; let _body: unknown;
  const res: any = {
    _status: () => _status, _body: () => _body,
    status(s: number) { _status = s; return res; }, json(b: unknown) { _body = b; return res; }, setHeader() {},
  };
  return res;
}

/** applyRateLimit that BLOCKS — mirrors the real 429 response + false return. */
function blocking() {
  return mockApplyRateLimit.mockImplementation(async (res: any) => { res.status(429).json({ code: 'RATE_LIMITED' }); return false; });
}

describe('listening generation entry points — rate-limit blocks the provider call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: { from: vi.fn() } });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
    mockGetListeningServiceClient.mockReturnValue({ from: vi.fn() });
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.AZURE_SPEECH_KEY = 'test-azure';
    process.env.AZURE_SPEECH_REGION = 'eastus';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret';
  });

  it('POST /story/generate: blocked → generateStorySession is NEVER called', async () => {
    blocking();
    const res = makeRes();
    await handler(makeReq(['story', 'generate']), res);

    expect(mockApplyRateLimit).toHaveBeenCalledWith(res, USER_ID, 'listening-generate');
    expect(mockGenerateStorySession).not.toHaveBeenCalled();
    expect(mockGenerateStorySession.mock.calls.length).toBe(0);
    expect(res._status()).toBe(429);
  });

  it('POST /generate: blocked → getOrCreateSharedListeningStory is NEVER called', async () => {
    blocking();
    const res = makeRes();
    await handler(makeReq(['generate']), res);

    expect(mockApplyRateLimit).toHaveBeenCalledWith(res, USER_ID, 'listening-generate');
    expect(mockGetOrCreateSharedListeningStory).not.toHaveBeenCalled();
    expect(mockGetOrCreateSharedListeningStory.mock.calls.length).toBe(0);
    expect(res._status()).toBe(429);
  });

  it('POST /story/generate: allowed → the rate limit is consulted and the provider proceeds', async () => {
    mockApplyRateLimit.mockResolvedValue(true);
    mockGenerateStorySession.mockResolvedValue({ level: 'B1' });
    const res = makeRes();
    await handler(makeReq(['story', 'generate']), res);

    expect(mockApplyRateLimit).toHaveBeenCalledWith(res, USER_ID, 'listening-generate');
    expect(mockGenerateStorySession).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });
});
