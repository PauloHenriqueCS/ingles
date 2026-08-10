import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockRequireAuth,
  mockApplyRateLimit,
  mockResolveSubscriptionStatus,
  mockGetRevenueCatApiSecretKey,
  mockGetSharedServiceClient,
  mockSyncSubscriptionFromEvent,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockApplyRateLimit: vi.fn().mockResolvedValue(true),
  mockResolveSubscriptionStatus: vi.fn(),
  mockGetRevenueCatApiSecretKey: vi.fn(),
  mockGetSharedServiceClient: vi.fn().mockReturnValue({}),
  mockSyncSubscriptionFromEvent: vi.fn().mockResolvedValue({ ok: true, action: 'upserted_assignment' }),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit }));
vi.mock('../_entitlements/subscription-status-service', () => ({
  resolveSubscriptionStatus: mockResolveSubscriptionStatus,
}));
vi.mock('../_env', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getRevenueCatApiSecretKey: mockGetRevenueCatApiSecretKey };
});
vi.mock('../_ai-gateway/usage-repository', () => ({ getSharedServiceClient: mockGetSharedServiceClient }));
vi.mock('../_billing/revenuecat-subscription-sync-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_billing/revenuecat-subscription-sync-service')>();
  return { ...actual, syncSubscriptionFromEvent: mockSyncSubscriptionFromEvent };
});

import { handleSubscriptionSyncRoute } from '../_billing/subscription-sync-route-handler';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const STATUS_SNAPSHOT = {
  status: 'active',
  accessType: 'commercial',
  planCode: 'essencial',
  planName: 'Essencial',
  trialEndsAt: null,
  trialDaysRemaining: null,
  subscriptionExpiresAt: '2026-09-01T00:00:00Z',
  canManageSubscription: false,
  canRestorePurchases: false,
  resolvedAt: new Date().toISOString(),
};

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: {}, ...overrides };
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

const originalFetch = global.fetch;

beforeEach(() => {
  mockRequireAuth.mockReset().mockResolvedValue({ userId: USER_ID, supabase: {}, accessToken: 'test-token' });
  mockApplyRateLimit.mockReset().mockResolvedValue(true);
  mockResolveSubscriptionStatus.mockReset().mockResolvedValue(STATUS_SNAPSHOT);
  mockGetRevenueCatApiSecretKey.mockReset().mockReturnValue('');
  mockSyncSubscriptionFromEvent.mockClear();
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('handleSubscriptionSyncRoute — auth/method/rate-limit', () => {
  it('rejects a non-POST method', async () => {
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq({ method: 'GET' }), res);
    expect(res._status()).toBe(405);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('requires authentication — never trusts a client-supplied user id', async () => {
    mockRequireAuth.mockResolvedValue(null);
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq({ body: { appUserId: 'someone-elses-id' } }), res);
    expect(mockResolveSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('is rate-limited', async () => {
    mockApplyRateLimit.mockResolvedValue(false);
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(mockResolveSubscriptionStatus).not.toHaveBeenCalled();
  });

  it('always resolves status for the authenticated session\'s own userId, never a body-supplied one', async () => {
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq({ body: { appUserId: 'not-me' } }), res);
    expect(mockResolveSubscriptionStatus).toHaveBeenCalledWith(USER_ID);
  });
});

describe('handleSubscriptionSyncRoute — RevenueCat not configured', () => {
  it('skips the RevenueCat lookup entirely and just returns the current backend status', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('');
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual(STATUS_SNAPSHOT);
  });
});

describe('handleSubscriptionSyncRoute — RevenueCat configured', () => {
  it('reconciles an active essencial subscription found on RevenueCat, then returns the fresh backend status', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        subscriber: {
          subscriptions: {
            'orodim.subscription.essential.monthly': {
              purchase_date: '2026-08-01T00:00:00Z',
              expires_date: '2026-09-01T00:00:00Z',
              original_transaction_id: 'txn-1',
              is_sandbox: false,
            },
          },
        },
      }),
    });
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(USER_ID)),
      expect.objectContaining({ headers: { Authorization: 'Bearer rc-secret-key' } }),
    );
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ appUserId: USER_ID, productId: 'orodim.subscription.essential.monthly', originalTransactionId: 'txn-1' }),
      expect.anything(),
    );
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual(STATUS_SNAPSHOT);
  });

  it('reconciles a Google base-plan subscription keyed with the :monthly suffix (matched by base product id, not exact key)', async () => {
    // The real regression: RevenueCat keys the Google subscription with the
    // base plan (':monthly'), so indexing by the bare id silently missed it.
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        subscriber: {
          subscriptions: {
            'orodim.subscription.plus.monthly:monthly': {
              purchase_date: '2026-08-01T00:00:00Z',
              expires_date: '2026-09-01T00:00:00Z',
              original_transaction_id: 'txn-plus-1',
              is_sandbox: true,
            },
          },
        },
      }),
    });
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1);
    // Same centralized policy inputs the webhook path also feeds: the SANDBOX
    // environment and the authenticated app_user_id are forwarded into
    // syncSubscriptionFromEvent (where isSandboxBlockedHere + the allowlist
    // decide), and the full ':basePlanId' product id is preserved.
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appUserId: USER_ID,
        environment: 'SANDBOX',
        productId: 'orodim.subscription.plus.monthly:monthly',
        originalTransactionId: 'txn-plus-1',
      }),
      expect.anything(),
    );
    expect(res._status()).toBe(200);
  });

  it('a non-sandbox base-plan subscription forwards environment PRODUCTION', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        subscriber: {
          subscriptions: {
            'orodim.subscription.essential.monthly:monthly': {
              purchase_date: '2026-08-01T00:00:00Z',
              expires_date: '2026-09-01T00:00:00Z',
              original_transaction_id: 'txn-ess-1',
              is_sandbox: false,
            },
          },
        },
      }),
    });
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'PRODUCTION', productId: 'orodim.subscription.essential.monthly:monthly' }),
      expect.anything(),
    );
  });

  it('a subscriber with no matching known product id triggers no reconciliation', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ subscriber: { subscriptions: {} } }) });
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('a 404 (no RevenueCat subscriber yet) is not an error — still returns the current backend status', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockResolvedValue({ ok: false, status: 404 });
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual(STATUS_SNAPSHOT);
  });

  it('a RevenueCat network failure never fails the request — falls through to the current backend status', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockRejectedValue(new Error('network down'));
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual(STATUS_SNAPSHOT);
  });

  it('never wires a second source of truth — the response is always exactly resolveSubscriptionStatus\'s own snapshot', async () => {
    mockGetRevenueCatApiSecretKey.mockReturnValue('rc-secret-key');
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ subscriber: { subscriptions: {} } }) });
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(res._body()).toBe(await mockResolveSubscriptionStatus.mock.results[0].value);
  });
});

describe('handleSubscriptionSyncRoute — errors', () => {
  it('returns 500 if resolving the final status fails', async () => {
    mockResolveSubscriptionStatus.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handleSubscriptionSyncRoute(makeReq(), res);
    expect(res._status()).toBe(500);
  });
});
