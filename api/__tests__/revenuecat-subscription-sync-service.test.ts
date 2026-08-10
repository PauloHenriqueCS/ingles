import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFlagBillingIssue, mockClearBillingIssue } = vi.hoisted(() => ({
  mockFlagBillingIssue: vi.fn().mockResolvedValue(undefined),
  mockClearBillingIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../_account/billing-block-repository', () => ({
  flagSubscriptionBillingIssue: mockFlagBillingIssue,
  clearSubscriptionBillingIssue: mockClearBillingIssue,
}));

import {
  syncSubscriptionFromEvent,
  isValidUuid,
  type RevenueCatLifecycleEvent,
} from '../_billing/revenuecat-subscription-sync-service';

const VALID_USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ESSENCIAL_PLAN_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

interface MockOptions {
  planRow?: { id: string } | null;
  planError?: { message: string } | null;
  upsertError?: unknown;
}

function makeMockSupabase(opts: MockOptions = {}) {
  const upsertCalls: Array<{ row: Record<string, unknown>; options: unknown }> = [];
  const planFilters: string[] = [];
  return {
    client: {
      from: (table: string) => {
        if (table === 'plans') {
          return {
            select: () => ({
              or: (filter: string) => {
                planFilters.push(filter);
                return {
                  maybeSingle: () => Promise.resolve({ data: opts.planRow ?? null, error: opts.planError ?? null }),
                };
              },
            }),
          };
        }
        if (table === 'user_plan_assignments') {
          return {
            upsert: (row: Record<string, unknown>, options: unknown) => {
              upsertCalls.push({ row, options });
              return Promise.resolve({ data: null, error: opts.upsertError ?? null });
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as any,
    upsertCalls,
    planFilters,
  };
}

function baseEvent(overrides: Partial<RevenueCatLifecycleEvent>): RevenueCatLifecycleEvent {
  return {
    type: 'INITIAL_PURCHASE',
    appUserId: VALID_USER_ID,
    environment: 'PRODUCTION',
    productId: 'orodim.subscription.essential.monthly',
    purchasedAtMs: Date.parse('2026-08-01T00:00:00Z'),
    expirationAtMs: Date.parse('2026-09-01T00:00:00Z'),
    originalTransactionId: 'txn-original-1',
    transferredTo: null,
    ...overrides,
  };
}

const originalVercelEnv = process.env.VERCEL_ENV;
const originalSandboxAllowlist = process.env.REVENUECAT_SANDBOX_TEST_USER_IDS;
beforeEach(() => {
  mockFlagBillingIssue.mockClear();
  mockClearBillingIssue.mockClear();
  delete process.env.VERCEL_ENV;
  delete process.env.REVENUECAT_SANDBOX_TEST_USER_IDS;
});
afterEach(() => {
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalSandboxAllowlist === undefined) delete process.env.REVENUECAT_SANDBOX_TEST_USER_IDS;
  else process.env.REVENUECAT_SANDBOX_TEST_USER_IDS = originalSandboxAllowlist;
});

describe('isValidUuid', () => {
  it('accepts a real UUID', () => {
    expect(isValidUuid(VALID_USER_ID)).toBe(true);
  });
  it('rejects an email, empty string, or non-UUID text', () => {
    expect(isValidUuid('user@example.com')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
  });
});

describe('syncSubscriptionFromEvent — Essencial / Plus', () => {
  it('Essencial: upserts an assignment with origin=subscription, status=active, real starts/ends from the event', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({}), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'upserted_assignment' });
    expect(upsertCalls).toHaveLength(1);
    const row = upsertCalls[0].row;
    expect(row.plan_id).toBe(ESSENCIAL_PLAN_ID);
    expect(row.origin).toBe('subscription');
    expect(row.status).toBe('active');
    expect(row.starts_at).toBe('2026-08-01T00:00:00.000Z');
    expect(row.ends_at).toBe('2026-09-01T00:00:00.000Z');
    expect(row.idempotency_key).toBe('revenuecat:subscription:txn-original-1');
    expect(upsertCalls[0].options).toEqual({ onConflict: 'idempotency_key' });
  });

  it('Plus: same reconciliation, different product id resolved to a different plan_id', async () => {
    const plusPlanId = 'cccccccc-0000-0000-0000-000000000003';
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: plusPlanId } });
    await syncSubscriptionFromEvent(
      baseEvent({ productId: 'orodim.subscription.plus.monthly' }),
      { supabase: client },
    );
    expect(upsertCalls[0].row.plan_id).toBe(plusPlanId);
  });

  it('never looks up a plan by name — only by store product id (structural: unknown product id is always rejected)', async () => {
    const { client } = makeMockSupabase({ planRow: null });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ productId: 'not.a.real.product' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'unknown_product' });
  });

  it('resolves the plan by both stores\' product-id columns, tolerating the Android base-plan suffix', async () => {
    const { client, upsertCalls, planFilters } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    // Android RevenueCat product id carries the base plan (":monthly").
    const outcome = await syncSubscriptionFromEvent(
      baseEvent({ productId: 'orodim.subscription.essential.monthly:monthly' }),
      { supabase: client },
    );
    expect(outcome).toEqual({ ok: true, action: 'upserted_assignment' });
    expect(upsertCalls[0].row.plan_id).toBe(ESSENCIAL_PLAN_ID);
    // The filter must query google_subscription_product_id and include the
    // suffix-stripped id, never depend on apple_product_id alone.
    const filter = planFilters[0];
    expect(filter).toContain('google_subscription_product_id.eq.orodim.subscription.essential.monthly');
    expect(filter).toContain('apple_product_id.eq.orodim.subscription.essential.monthly:monthly');
  });
});

describe('syncSubscriptionFromEvent — renewal / cancellation / expiration', () => {
  it('RENEWAL: extends ends_at, stays active, never touches cancelled_at (key omitted from the upsert payload)', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    await syncSubscriptionFromEvent(baseEvent({ type: 'RENEWAL', expirationAtMs: Date.parse('2026-10-01T00:00:00Z') }), { supabase: client });
    const row = upsertCalls[0].row;
    expect(row.status).toBe('active');
    expect(row.ends_at).toBe('2026-10-01T00:00:00.000Z');
    expect('cancelled_at' in row).toBe(false);
  });

  it('CANCELLATION with a future expiration: stays active, keeps access until ends_at, sets cancelled_at — never shortens ends_at', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const future = Date.now() + 5 * 24 * 60 * 60 * 1000;
    await syncSubscriptionFromEvent(baseEvent({ type: 'CANCELLATION', expirationAtMs: future }), { supabase: client });
    const row = upsertCalls[0].row;
    expect(row.status).toBe('active');
    expect(row.ends_at).toBe(new Date(future).toISOString());
    expect(row.cancelled_at).not.toBeNull();
    expect(row.cancel_reason).toBe('revenuecat_cancellation');
  });

  it('UNCANCELLATION: clears cancelled_at/cancel_reason back to null', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    await syncSubscriptionFromEvent(baseEvent({ type: 'UNCANCELLATION', expirationAtMs: Date.now() + 86_400_000 }), { supabase: client });
    const row = upsertCalls[0].row;
    expect(row.cancelled_at).toBeNull();
    expect(row.cancel_reason).toBeNull();
  });

  it('EXPIRATION: status becomes expired', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const past = Date.now() - 60_000;
    await syncSubscriptionFromEvent(baseEvent({ type: 'EXPIRATION', expirationAtMs: past }), { supabase: client });
    expect(upsertCalls[0].row.status).toBe('expired');
  });

  it('any event whose expiration has already elapsed becomes expired, by data, not just by type name', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const past = Date.now() - 60_000;
    await syncSubscriptionFromEvent(baseEvent({ type: 'REFUND_REVERSED', expirationAtMs: past }), { supabase: client });
    expect(upsertCalls[0].row.status).toBe('expired');
  });
});

describe('syncSubscriptionFromEvent — billing issue / recovery', () => {
  it('BILLING_ISSUE: flags via the existing user_billing_blocks structure, never inserts an assignment row', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ type: 'BILLING_ISSUE' }), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'billing_issue_flagged' });
    expect(mockFlagBillingIssue).toHaveBeenCalledWith(VALID_USER_ID);
    expect(upsertCalls).toHaveLength(0);
  });

  it('RENEWAL clears a previously flagged billing issue — "recuperação de cobrança" via the existing structure', async () => {
    const { client } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    await syncSubscriptionFromEvent(baseEvent({ type: 'RENEWAL' }), { supabase: client });
    expect(mockClearBillingIssue).toHaveBeenCalledWith(VALID_USER_ID, expect.any(String));
  });

  it('CANCELLATION does NOT clear a billing issue (not a payment-recovery signal)', async () => {
    const { client } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    await syncSubscriptionFromEvent(baseEvent({ type: 'CANCELLATION', expirationAtMs: Date.now() + 86_400_000 }), { supabase: client });
    expect(mockClearBillingIssue).not.toHaveBeenCalled();
  });
});

describe('syncSubscriptionFromEvent — safety gates', () => {
  it('rejects an invalid app_user_id (never a fabricated UUID, never silently accepted)', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ appUserId: 'not-a-uuid' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_app_user_id' });
    expect(upsertCalls).toHaveLength(0);
  });

  it('blocks a SANDBOX event when this deployment is production (VERCEL_ENV=production)', async () => {
    process.env.VERCEL_ENV = 'production';
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ environment: 'SANDBOX' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'sandbox_blocked_in_production' });
    expect(upsertCalls).toHaveLength(0);
  });

  it('allows a SANDBOX event when this deployment is NOT production (e.g. homologation)', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ environment: 'SANDBOX' }), { supabase: client });
    expect(outcome.ok).toBe(true);
    expect(upsertCalls).toHaveLength(1);
  });

  it('a plan resolved by product id is never the internal unlimited plan — it has no store product id, so it structurally can never match', async () => {
    // No planRow configured for any product id other than a real commercial
    // one — this test documents the invariant rather than exercising a
    // code branch: INTERNAL_UNLIMITED_PLAN_CODE ('24317180') has neither an
    // apple_product_id nor a google_subscription_product_id in the database,
    // so the product-id filter can never resolve to it.
    const { client } = makeMockSupabase({ planRow: null });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ productId: '24317180' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'unknown_product' });
  });

  it('rejects an event with no original_transaction_id — never upserts without a stable idempotency key', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ originalTransactionId: null }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'missing_original_transaction_id' });
    expect(upsertCalls).toHaveLength(0);
  });

  it('ignores a non-lifecycle event type without erroring', async () => {
    const { client } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ type: 'PAYWALL_IMPRESSION' }), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'ignored_not_lifecycle_event' });
  });
});

describe('syncSubscriptionFromEvent — Android base plans (:basePlanId) & sandbox test allowlist', () => {
  const PLUS_PLAN_ID = 'cccccccc-0000-0000-0000-000000000003';

  it('Plus bare product id + production upserts', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: PLUS_PLAN_ID } });
    process.env.VERCEL_ENV = 'production';
    const outcome = await syncSubscriptionFromEvent(baseEvent({ productId: 'orodim.subscription.plus.monthly' }), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'upserted_assignment' });
    expect(upsertCalls[0].row.plan_id).toBe(PLUS_PLAN_ID);
  });

  it('Plus with the Android :monthly base-plan suffix resolves the plan and upserts (production)', async () => {
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: PLUS_PLAN_ID } });
    process.env.VERCEL_ENV = 'production';
    const outcome = await syncSubscriptionFromEvent(baseEvent({ productId: 'orodim.subscription.plus.monthly:monthly' }), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'upserted_assignment' });
    expect(upsertCalls[0].row.plan_id).toBe(PLUS_PLAN_ID);
  });

  it('Android :monthly + is_sandbox=false (environment PRODUCTION) upserts even on the production deployment', async () => {
    process.env.VERCEL_ENV = 'production';
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: PLUS_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(
      baseEvent({ productId: 'orodim.subscription.plus.monthly:monthly', environment: 'PRODUCTION' }),
      { supabase: client },
    );
    expect(outcome.ok).toBe(true);
    expect(upsertCalls).toHaveLength(1);
  });

  it('Android :monthly + SANDBOX in production is APPLIED for an allowlisted test user', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.REVENUECAT_SANDBOX_TEST_USER_IDS = `eeeeeeee-0000-0000-0000-000000000009,${VALID_USER_ID}`;
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: PLUS_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(
      baseEvent({ productId: 'orodim.subscription.plus.monthly:monthly', environment: 'SANDBOX' }),
      { supabase: client },
    );
    expect(outcome).toEqual({ ok: true, action: 'upserted_assignment' });
    expect(upsertCalls).toHaveLength(1);
  });

  it('Android :monthly + SANDBOX in production is STILL BLOCKED for a user NOT on the allowlist', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.REVENUECAT_SANDBOX_TEST_USER_IDS = 'dddddddd-0000-0000-0000-000000000004';
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: PLUS_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(
      baseEvent({ productId: 'orodim.subscription.plus.monthly:monthly', environment: 'SANDBOX' }),
      { supabase: client },
    );
    expect(outcome).toEqual({ ok: false, reason: 'sandbox_blocked_in_production' });
    expect(upsertCalls).toHaveLength(0);
  });

  it('allowlist UUID match is case-insensitive', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.REVENUECAT_SANDBOX_TEST_USER_IDS = VALID_USER_ID.toUpperCase();
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ environment: 'SANDBOX' }), { supabase: client });
    expect(outcome.ok).toBe(true);
    expect(upsertCalls).toHaveLength(1);
  });

  it('an empty allowlist keeps the original behaviour: every sandbox event blocked in production', async () => {
    process.env.VERCEL_ENV = 'production';
    // REVENUECAT_SANDBOX_TEST_USER_IDS unset (cleared in beforeEach)
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    const outcome = await syncSubscriptionFromEvent(baseEvent({ environment: 'SANDBOX' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'sandbox_blocked_in_production' });
    expect(upsertCalls).toHaveLength(0);
  });
});

describe('syncSubscriptionFromEvent — TRANSFER', () => {
  it('reconciles the assignment for the transferred-to user, not the original event app_user_id', async () => {
    const transferredToUserId = 'dddddddd-0000-0000-0000-000000000004';
    const { client, upsertCalls } = makeMockSupabase({ planRow: { id: ESSENCIAL_PLAN_ID } });
    await syncSubscriptionFromEvent(
      baseEvent({ type: 'TRANSFER', transferredTo: [transferredToUserId] }),
      { supabase: client },
    );
    expect(upsertCalls[0].row.user_id).toBe(transferredToUserId);
    expect(upsertCalls[0].row.created_by).toBe(transferredToUserId);
  });
});
