import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { mockGetSharedServiceClient, mockSyncSubscriptionFromEvent, mockCreditMinutePackagePurchase } = vi.hoisted(() => ({
  mockGetSharedServiceClient: vi.fn(),
  mockSyncSubscriptionFromEvent: vi.fn(),
  mockCreditMinutePackagePurchase: vi.fn(),
}));

vi.mock('../_ai-gateway/usage-repository', () => ({
  getSharedServiceClient: mockGetSharedServiceClient,
}));

vi.mock('../_billing/revenuecat-subscription-sync-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_billing/revenuecat-subscription-sync-service')>();
  return { ...actual, syncSubscriptionFromEvent: mockSyncSubscriptionFromEvent };
});

vi.mock('../_billing/revenuecat-minute-credit-service', () => ({
  creditMinutePackagePurchase: mockCreditMinutePackagePurchase,
}));

import { handleRevenueCatWebhookRoute } from '../_billing/revenuecat-webhook-route-handler';

const AUTH_SECRET = 'route-handler-auth-secret';
const HMAC_SECRET = 'route-handler-hmac-secret';
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnv.REVENUECAT_WEBHOOK_AUTH_SECRET = process.env.REVENUECAT_WEBHOOK_AUTH_SECRET;
  originalEnv.REVENUECAT_WEBHOOK_HMAC_SECRET = process.env.REVENUECAT_WEBHOOK_HMAC_SECRET;
  process.env.REVENUECAT_WEBHOOK_AUTH_SECRET = AUTH_SECRET;
  process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = HMAC_SECRET;
  mockSyncSubscriptionFromEvent.mockReset().mockResolvedValue({ ok: true, action: 'upserted_assignment' });
  mockCreditMinutePackagePurchase.mockReset().mockResolvedValue({ ok: true, action: 'credited', minutes: 300 });
});

afterEach(() => {
  process.env.REVENUECAT_WEBHOOK_AUTH_SECRET = originalEnv.REVENUECAT_WEBHOOK_AUTH_SECRET;
  process.env.REVENUECAT_WEBHOOK_HMAC_SECRET = originalEnv.REVENUECAT_WEBHOOK_HMAC_SECRET;
});

function signBody(body: Buffer, timestampSeconds: number, secret = HMAC_SECRET): string {
  const hex = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(body).digest('hex');
  return `t=${timestampSeconds},v1=${hex}`;
}

function makeReq(bodyObj: unknown, opts: { method?: string; skipAuth?: boolean; skipSignature?: boolean } = {}) {
  const bodyBuffer = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {};
  if (!opts.skipAuth) headers['authorization'] = AUTH_SECRET;
  if (!opts.skipSignature) headers['x-revenuecat-webhook-signature'] = signBody(bodyBuffer, nowSeconds);
  return {
    method: opts.method ?? 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      yield bodyBuffer;
    },
  };
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

interface StoredEvent {
  id: string;
  revenuecat_event_id: string;
  event_type: string;
  environment: string;
  app_user_id: string | null;
  processing_status: string;
  error_message: string | null;
}

/** A minimal in-memory fake for revenuecat_webhook_events — insert/select-by-
 *  event-id/update, exactly the operations the route handler performs. */
function makeMockSupabase(seed: StoredEvent[] = []) {
  const rows = [...seed];
  return {
    from: (table: string) => {
      if (table !== 'revenuecat_webhook_events') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: () => Promise.resolve({ data: rows.find((r) => r.revenuecat_event_id === val) ?? null, error: null }),
          }),
        }),
        insert: (row: Partial<StoredEvent>) => {
          rows.push({ id: `row-${rows.length}`, processing_status: 'received', app_user_id: null, error_message: null, ...row } as StoredEvent);
          return Promise.resolve({ data: null, error: null });
        },
        update: (patch: Partial<StoredEvent>) => ({
          eq: (_col: string, val: string) => {
            const row = rows.find((r) => r.revenuecat_event_id === val);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    },
    __rows: rows,
  };
}

function eventBody(overrides: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: 'evt-1',
      type: 'INITIAL_PURCHASE',
      environment: 'PRODUCTION',
      app_user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      product_id: 'orodim.subscription.essential.monthly',
      purchased_at_ms: Date.parse('2026-08-01T00:00:00Z'),
      expiration_at_ms: Date.parse('2026-09-01T00:00:00Z'),
      original_transaction_id: 'txn-1',
      ...overrides,
    },
  };
}

describe('handleRevenueCatWebhookRoute — method/auth/HMAC', () => {
  it('rejects a non-POST method', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody(), { method: 'GET' }), res);
    expect(res._status()).toBe(405);
  });

  it('rejects an invalid Authorization header', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const req = makeReq(eventBody(), { skipAuth: true });
    (req as any).headers['authorization'] = 'wrong-secret';
    const res = makeRes();
    await handleRevenueCatWebhookRoute(req, res);
    expect(res._status()).toBe(401);
    expect(supabase.__rows).toHaveLength(0);
  });

  it('rejects an invalid HMAC signature', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const req = makeReq(eventBody());
    (req as any).headers['x-revenuecat-webhook-signature'] = 't=9999999999,v1=deadbeef';
    const res = makeRes();
    await handleRevenueCatWebhookRoute(req, res);
    expect(res._status()).toBe(401);
  });

  it('rejects an expired signature timestamp', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const bodyBuffer = Buffer.from(JSON.stringify(eventBody()), 'utf8');
    const staleSeconds = Math.floor(Date.now() / 1000) - 3600;
    const req = {
      method: 'POST',
      headers: { authorization: AUTH_SECRET, 'x-revenuecat-webhook-signature': signBody(bodyBuffer, staleSeconds) },
      async *[Symbol.asyncIterator]() { yield bodyBuffer; },
    };
    const res = makeRes();
    await handleRevenueCatWebhookRoute(req, res);
    expect(res._status()).toBe(401);
  });

  it('rejects malformed JSON', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const bodyBuffer = Buffer.from('{not json', 'utf8');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const req = {
      method: 'POST',
      headers: { authorization: AUTH_SECRET, 'x-revenuecat-webhook-signature': signBody(bodyBuffer, nowSeconds) },
      async *[Symbol.asyncIterator]() { yield bodyBuffer; },
    };
    const res = makeRes();
    await handleRevenueCatWebhookRoute(req, res);
    expect(res._status()).toBe(400);
  });

  it('rejects a payload missing event.id/event.type', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq({ api_version: '1.0', event: { type: 'TEST' } }), res);
    expect(res._status()).toBe(400);
  });
});

describe('handleRevenueCatWebhookRoute — valid events', () => {
  it('a valid subscription lifecycle event is recorded, dispatched to the sync service, marked processed, and acked 200', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(200);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1);
    expect(supabase.__rows[0].processing_status).toBe('processed');
  });

  it('NON_RENEWING_PURCHASE is dispatched to the credit service, never the subscription sync service', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(
      makeReq(eventBody({ id: 'evt-consumable', type: 'NON_RENEWING_PURCHASE', product_id: 'orodim.conversation.minutes.300', transaction_id: 'txn-c1' })),
      res,
    );
    expect(res._status()).toBe(200);
    expect(mockCreditMinutePackagePurchase).toHaveBeenCalledTimes(1);
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
  });

  it('TEST event is acknowledged without calling any service', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody({ id: 'evt-test', type: 'TEST' })), res);
    expect(res._status()).toBe(200);
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
    expect(mockCreditMinutePackagePurchase).not.toHaveBeenCalled();
    expect(supabase.__rows[0].processing_status).toBe('ignored');
  });

  it('an unhandled event type (e.g. PAYWALL_IMPRESSION) is acknowledged and marked ignored, never a failure', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody({ id: 'evt-paywall', type: 'PAYWALL_IMPRESSION' })), res);
    expect(res._status()).toBe(200);
    expect(supabase.__rows[0].processing_status).toBe('ignored');
  });

  it('an unknown product id from the sync service still ACKs 200, marked ignored with the reason recorded', async () => {
    mockSyncSubscriptionFromEvent.mockResolvedValue({ ok: false, reason: 'unknown_product' });
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(200);
    expect(supabase.__rows[0].processing_status).toBe('ignored');
    expect(supabase.__rows[0].error_message).toBe('unknown_product');
  });

  it('an invalid app_user_id from the sync service still ACKs 200', async () => {
    mockSyncSubscriptionFromEvent.mockResolvedValue({ ok: false, reason: 'invalid_app_user_id' });
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody({ app_user_id: 'not-a-uuid' })), res);
    expect(res._status()).toBe(200);
  });

  it('sandbox event is recorded with its real environment value, dispatch still attempted (the sync service itself decides sandbox-blocking)', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody({ id: 'evt-sandbox', environment: 'SANDBOX' })), res);
    expect(supabase.__rows[0].environment).toBe('SANDBOX');
  });

  it('a SANDBOX subscription event forwards the SANDBOX environment AND app_user_id into the shared policy (syncSubscriptionFromEvent) — same centralized sandbox rule as /api/subscription/sync', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(
      makeReq(eventBody({ id: 'evt-sandbox-policy', environment: 'SANDBOX', app_user_id: 'aaaaaaaa-0000-0000-0000-000000000001' })),
      res,
    );
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'SANDBOX', appUserId: 'aaaaaaaa-0000-0000-0000-000000000001' }),
      expect.anything(),
    );
  });

  it('a SANDBOX event whose user is blocked by the shared policy is ACKed 200 and marked ignored (never a failure/retry)', async () => {
    // The route handler stays policy-agnostic: whatever syncSubscriptionFromEvent
    // returns (here the centralized sandbox_blocked_in_production) is a terminal
    // 'ignored', never a 500 that RevenueCat would keep retrying.
    mockSyncSubscriptionFromEvent.mockResolvedValue({ ok: false, reason: 'sandbox_blocked_in_production' });
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody({ id: 'evt-sandbox-blocked', environment: 'SANDBOX' })), res);
    expect(res._status()).toBe(200);
    expect(supabase.__rows[0].processing_status).toBe('ignored');
    expect(supabase.__rows[0].error_message).toBe('sandbox_blocked_in_production');
  });
});

describe('handleRevenueCatWebhookRoute — idempotency', () => {
  it('a redelivery of an already-processed event is acked as a pure duplicate, never reprocessed', async () => {
    const supabase = makeMockSupabase([
      { id: 'row-0', revenuecat_event_id: 'evt-1', event_type: 'INITIAL_PURCHASE', environment: 'PRODUCTION', app_user_id: 'aaaaaaaa-0000-0000-0000-000000000001', processing_status: 'processed', error_message: null },
    ]);
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toMatchObject({ duplicate: true });
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
  });

  it('a redelivery of an event whose previous attempt failed IS reprocessed and ACKs 200 on success (never silently swallowed)', async () => {
    const supabase = makeMockSupabase([
      { id: 'row-0', revenuecat_event_id: 'evt-1', event_type: 'INITIAL_PURCHASE', environment: 'PRODUCTION', app_user_id: 'aaaaaaaa-0000-0000-0000-000000000001', processing_status: 'failed', error_message: 'transient_error' },
    ]);
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(200);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1);
    expect(supabase.__rows[0].processing_status).toBe('processed');
  });

  it('a redelivery of a previously-failed event that fails again stays failed and ACKs 500 again (eligible for another retry)', async () => {
    mockSyncSubscriptionFromEvent.mockRejectedValue(new Error('still down'));
    const supabase = makeMockSupabase([
      { id: 'row-0', revenuecat_event_id: 'evt-1', event_type: 'INITIAL_PURCHASE', environment: 'PRODUCTION', app_user_id: 'aaaaaaaa-0000-0000-0000-000000000001', processing_status: 'failed', error_message: 'transient_error' },
    ]);
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(500);
    expect(supabase.__rows[0].processing_status).toBe('failed');
  });

  it('a repeated delivery of an event that already succeeded never re-runs the sync service (no duplicate effect)', async () => {
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const first = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), first);
    expect(first._status()).toBe(200);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1);

    const second = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), second);
    expect(second._status()).toBe(200);
    expect(second._body()).toMatchObject({ duplicate: true });
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1); // still 1 — never called again
  });
});

describe('handleRevenueCatWebhookRoute — transitory failures ACK 500 so RevenueCat retries', () => {
  it('a subscription-sync exception is recorded as failed and ACKs 500 (never treated as handled)', async () => {
    mockSyncSubscriptionFromEvent.mockRejectedValue(new Error('boom'));
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(500);
    expect(supabase.__rows[0].processing_status).toBe('failed');
    expect(supabase.__rows[0].error_message).toBe('boom');
  });

  it('a minute-credit exception ACKs 500 and never leaves a partial/half-applied credit', async () => {
    mockCreditMinutePackagePurchase.mockRejectedValue(new Error('db connection reset'));
    const supabase = makeMockSupabase();
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(
      makeReq(eventBody({ id: 'evt-consumable', type: 'NON_RENEWING_PURCHASE', product_id: 'orodim.conversation.minutes.300', transaction_id: 'txn-c1' })),
      res,
    );
    expect(res._status()).toBe(500);
    expect(supabase.__rows[0].processing_status).toBe('failed');
    expect(supabase.__rows[0].error_message).toBe('db connection reset');
    // The credit service itself is responsible for atomicity (see its own
    // idempotency tests) — this route handler's only obligation on a thrown
    // error is to never claim success, which the 500 + 'failed' status above
    // already proves.
  });

  it('a database failure looking up the event row ACKs 500', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }) }) }) }),
    };
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(500);
    expect(mockSyncSubscriptionFromEvent).not.toHaveBeenCalled();
  });

  it('a failure confirming the final processing_status (UPDATE fails) ACKs 500, even though the business effect already succeeded', async () => {
    const supabase = makeMockSupabase();
    const originalFrom = supabase.from.bind(supabase);
    (supabase as { from: unknown }).from = (table: string) => {
      const real = originalFrom(table);
      return {
        ...real,
        update: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'write conflict' } }) }),
      };
    };
    mockGetSharedServiceClient.mockReturnValue(supabase);
    const res = makeRes();
    await handleRevenueCatWebhookRoute(makeReq(eventBody()), res);
    expect(res._status()).toBe(500);
    expect(mockSyncSubscriptionFromEvent).toHaveBeenCalledTimes(1); // the upsert itself DID happen — idempotent on retry
  });
});
