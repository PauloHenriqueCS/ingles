/**
 * Audit §18 / §7 — the pronunciation /start endpoint must rate-limit BEFORE it
 * mints an Azure Speech token (the credential the browser then uses for the
 * paid assessment). Uses the pre-existing 'pronunciation-start' key that until
 * now was defined but never wired here. Proves the Azure token is NEVER issued
 * when the rate limit blocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const {
  mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockApplyRateLimit, mockIssueAzureSpeechToken,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockApplyRateLimit: vi.fn(),
  mockIssueAzureSpeechToken: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit, RATE_LIMITS: {} }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({ getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements }));
vi.mock('../_azure-speech', () => ({
  issueAzureSpeechToken: mockIssueAzureSpeechToken,
  AzureSpeechError: class AzureSpeechError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
}));

import handler from '../pronunciation/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000002';
const UUID = '11111111-1111-1111-1111-111111111111';

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

function makeReq() {
  return { method: 'POST', headers: { authorization: 'Bearer test' }, query: { slug: ['start'] }, url: '/api/pronunciation/start', body: { textVersionId: UUID, attemptId: UUID } };
}
function makeRes() {
  let _status = 200; let _body: unknown;
  const res: any = {
    _status: () => _status, _body: () => _body,
    status(s: number) { _status = s; return res; }, json(b: unknown) { _body = b; return res; }, setHeader() {},
  };
  return res;
}

describe('pronunciation /start — rate-limit blocks the Azure token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: { rpc: vi.fn() } });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
    process.env.AZURE_SPEECH_REGION = 'eastus';
  });

  it('blocked → issueAzureSpeechToken is NEVER called and the reservation RPC is not reached', async () => {
    const supabaseRpc = vi.fn();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: { rpc: supabaseRpc } });
    mockApplyRateLimit.mockImplementation(async (res: any) => { res.status(429).json({ code: 'RATE_LIMITED' }); return false; });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockApplyRateLimit).toHaveBeenCalledWith(res, USER_ID, 'pronunciation-start');
    expect(mockIssueAzureSpeechToken).not.toHaveBeenCalled();
    expect(mockIssueAzureSpeechToken.mock.calls.length).toBe(0);
    expect(supabaseRpc).not.toHaveBeenCalled(); // reserve_pronunciation_assessment never ran
    expect(res._status()).toBe(429);
  });
});
