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
  reconcileSubscriptionStateFromRest,
  isValidUuid,
  type RevenueCatLifecycleEvent,
  type RevenueCatRestSubscriptionState,
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

// ── REST state reconciliation (POST /api/subscription/sync) — the real REST
// payload has NO original_transaction_id and a per-transaction
// store_transaction_id, so identity is (user, plan) state, never a txn.
const PLUS_PLAN_ID = 'cccccccc-0000-0000-0000-000000000003';
const ESSENTIAL_PRODUCT = 'orodim.subscription.essential.monthly';
const PLUS_PRODUCT = 'orodim.subscription.plus.monthly';

interface SeedRow {
  id?: string;
  user_id: string;
  plan_id: string;
  origin: string;
  starts_at: string;
  ends_at?: string | null;
  status?: string;
  idempotency_key?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  pending_plan_id?: string | null;
  pending_effective_at?: string | null;
  auto_renew?: boolean;
}

/** In-memory user_plan_assignments + a resolvable plans lookup, supporting the
 *  exact select/update/insert chain reconcileSubscriptionStateFromRest uses. */
function makeReconcileMock(opts: { planIdForProduct?: string | null; seed?: SeedRow[] } = {}) {
  const rows: Array<Record<string, unknown>> = (opts.seed ?? []).map((r, i) => ({ id: r.id ?? `seed-${i}`, ...r }));
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ col: string; val: unknown; fields: Record<string, unknown> }> = [];
  let insCount = 0;
  const client = {
    from: (table: string) => {
      if (table === 'plans') {
        return {
          select: () => ({
            or: () => ({
              maybeSingle: () => Promise.resolve({ data: opts.planIdForProduct ? { id: opts.planIdForProduct } : null, error: null }),
            }),
          }),
        };
      }
      if (table === 'user_plan_assignments') {
        return {
          select: () => {
            const filters: Record<string, unknown> = {};
            const api: Record<string, unknown> = {
              eq: (col: string, val: unknown) => { filters[col] = val; return api; },
              order: () => api,
              limit: () => api,
              maybeSingle: () => {
                const match = rows
                  .filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
                  .sort((a, b) => String(b.starts_at ?? '').localeCompare(String(a.starts_at ?? '')))[0];
                return Promise.resolve({ data: match ? { id: match.id } : null, error: null });
              },
            };
            return api;
          },
          update: (fields: Record<string, unknown>) => ({
            eq: (col: string, val: unknown) => {
              const target = rows.find((r) => r[col] === val);
              if (target) Object.assign(target, fields);
              updates.push({ col, val, fields });
              return Promise.resolve({ data: null, error: null });
            },
          }),
          insert: (row: Record<string, unknown>) => {
            if (row.idempotency_key && rows.some((r) => r.idempotency_key === row.idempotency_key)) {
              return Promise.resolve({ data: null, error: { code: '23505' } });
            }
            const created = { id: `ins-${insCount++}`, ...row };
            rows.push(created);
            inserts.push(created);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as Parameters<typeof reconcileSubscriptionStateFromRest>[1] extends { supabase?: infer S } ? S : never;
  return { client, rows, inserts, updates };
}

function restState(overrides: Partial<RevenueCatRestSubscriptionState> = {}): RevenueCatRestSubscriptionState {
  return {
    appUserId: VALID_USER_ID,
    environment: 'PRODUCTION',
    productId: ESSENTIAL_PRODUCT,
    purchaseDateMs: Date.parse('2026-08-01T00:00:00Z'),
    expiresDateMs: Date.parse('2026-09-01T00:00:00Z'),
    unsubscribeDetectedAtMs: null,
    storeTransactionId: 'gpa.txn-aaa',
    ...overrides,
  };
}

const NOW = new Date('2026-08-05T00:00:00Z'); // between purchase and expiry above

describe('reconcileSubscriptionStateFromRest — state, not transaction', () => {
  it('inserts a commercial assignment from a REST snapshot with NO original_transaction_id, keyed STABLY by (user, plan) — never by store_transaction_id', async () => {
    const { client, inserts, updates } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    const outcome = await reconcileSubscriptionStateFromRest(restState(), { supabase: client, now: NOW });
    expect(outcome).toEqual({ ok: true, action: 'reconciled_active' });
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(inserts[0].plan_id).toBe(ESSENCIAL_PLAN_ID);
    expect(inserts[0].origin).toBe('subscription');
    expect(inserts[0].status).toBe('active');
    expect(inserts[0].starts_at).toBe('2026-08-01T00:00:00.000Z');
    expect(inserts[0].ends_at).toBe('2026-09-01T00:00:00.000Z');
    // Stable per-(user, product) key — the store_transaction_id never appears in it.
    expect(inserts[0].idempotency_key).toBe(`revenuecat:subscription:reconcile:${VALID_USER_ID}:${ESSENTIAL_PRODUCT}`);
    expect(String(inserts[0].idempotency_key)).not.toContain('gpa.txn-aaa');
  });

  it('a renewal (store_transaction_id changed, ends_at advanced) UPDATES the same (user, plan) row — never a new one', async () => {
    const { client, inserts, updates, rows } = makeReconcileMock({
      planIdForProduct: ESSENCIAL_PLAN_ID,
      seed: [{ user_id: VALID_USER_ID, plan_id: ESSENCIAL_PLAN_ID, origin: 'subscription', starts_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-09-01T00:00:00.000Z', status: 'active', idempotency_key: `revenuecat:subscription:reconcile:${VALID_USER_ID}:${ESSENTIAL_PRODUCT}` }],
    });
    // New renewal: later purchase/expiry and a DIFFERENT store_transaction_id.
    const outcome = await reconcileSubscriptionStateFromRest(
      restState({ purchaseDateMs: Date.parse('2026-09-01T00:00:00Z'), expiresDateMs: Date.parse('2026-10-01T00:00:00Z'), storeTransactionId: 'gpa.txn-DIFFERENT' }),
      { supabase: client, now: NOW },
    );
    expect(outcome.ok).toBe(true);
    expect(inserts).toHaveLength(0);       // no new row
    expect(updates).toHaveLength(1);       // updated in place
    expect(rows).toHaveLength(1);          // still exactly one row
    expect(rows[0].ends_at).toBe('2026-10-01T00:00:00.000Z'); // ends_at advanced
  });

  it('repeated /sync with the same state does not duplicate (insert once, then update)', async () => {
    const { client, inserts, rows } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    await reconcileSubscriptionStateFromRest(restState(), { supabase: client, now: NOW });
    await reconcileSubscriptionStateFromRest(restState(), { supabase: client, now: NOW });
    await reconcileSubscriptionStateFromRest(restState(), { supabase: client, now: NOW });
    expect(inserts).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('Essential -> Plus reconciles the Plus (user, plan) row (its own stable key), leaving the essential row alone', async () => {
    const { client, inserts } = makeReconcileMock({
      planIdForProduct: PLUS_PLAN_ID,
      seed: [{ user_id: VALID_USER_ID, plan_id: ESSENCIAL_PLAN_ID, origin: 'subscription', starts_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-09-01T00:00:00.000Z', status: 'active', idempotency_key: `revenuecat:subscription:reconcile:${VALID_USER_ID}:${ESSENTIAL_PRODUCT}` }],
    });
    const outcome = await reconcileSubscriptionStateFromRest(restState({ productId: PLUS_PRODUCT }), { supabase: client, now: NOW });
    expect(outcome.ok).toBe(true);
    expect(inserts).toHaveLength(1); // a new plus row (different (user, plan))
    expect(inserts[0].plan_id).toBe(PLUS_PLAN_ID);
    expect(inserts[0].idempotency_key).toBe(`revenuecat:subscription:reconcile:${VALID_USER_ID}:${PLUS_PRODUCT}`);
  });

  it('reactivating a plan with a STALE cancelled_at (healthy, auto-renewing) CLEARS it — the audited 14:30→16:33 bug', async () => {
    const { client, inserts, updates, rows } = makeReconcileMock({
      planIdForProduct: ESSENCIAL_PLAN_ID,
      // A row left cancelled from a PAST life of the same (user, plan).
      seed: [{ user_id: VALID_USER_ID, plan_id: ESSENCIAL_PLAN_ID, origin: 'subscription', status: 'active', starts_at: '2026-07-01T00:00:00.000Z', ends_at: '2026-08-01T00:00:00.000Z', cancelled_at: '2026-07-15T00:00:00.000Z', cancel_reason: 'revenuecat_unsubscribe_detected', idempotency_key: `revenuecat:subscription:reconcile:${VALID_USER_ID}:${ESSENTIAL_PRODUCT}` }],
    });
    // Fresh active subscription, NO unsubscribe flag (auto-renewing).
    await reconcileSubscriptionStateFromRest(restState({ unsubscribeDetectedAtMs: null }), { supabase: client, now: NOW });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(rows).toHaveLength(1);            // same row reused, never duplicated
    expect(rows[0].status).toBe('active');
    expect(rows[0].cancelled_at).toBeNull(); // <- stale cancellation cleared
    expect(rows[0].cancel_reason).toBeNull();
    expect(rows[0].auto_renew).toBe(true);
  });

  it('reactivating a plan with STALE pending_* (healthy, auto-renewing) CLEARS the pending residue', async () => {
    const { client, rows } = makeReconcileMock({
      planIdForProduct: ESSENCIAL_PLAN_ID,
      seed: [{ user_id: VALID_USER_ID, plan_id: ESSENCIAL_PLAN_ID, origin: 'subscription', status: 'active', starts_at: '2026-07-01T00:00:00.000Z', ends_at: '2026-08-01T00:00:00.000Z', pending_plan_id: PLUS_PLAN_ID, pending_effective_at: '2026-07-20T00:00:00.000Z', idempotency_key: `revenuecat:subscription:reconcile:${VALID_USER_ID}:${ESSENTIAL_PRODUCT}` }],
    });
    await reconcileSubscriptionStateFromRest(restState({ unsubscribeDetectedAtMs: null }), { supabase: client, now: NOW });
    expect(rows[0].pending_plan_id).toBeNull();
    expect(rows[0].pending_effective_at).toBeNull();
  });

  it('when the store DOES report unsubscribe, cancelled_at/pending set by the webhook are PRESERVED (REST never erases them)', async () => {
    const { client, rows } = makeReconcileMock({
      planIdForProduct: ESSENCIAL_PLAN_ID,
      seed: [{ user_id: VALID_USER_ID, plan_id: ESSENCIAL_PLAN_ID, origin: 'subscription', status: 'active', starts_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-09-01T00:00:00.000Z', cancelled_at: '2026-08-03T00:00:00.000Z', cancel_reason: 'revenuecat_cancellation', idempotency_key: `revenuecat:subscription:reconcile:${VALID_USER_ID}:${ESSENTIAL_PRODUCT}` }],
    });
    // Unsubscribe flag present → REST must not touch the webhook-owned fields.
    await reconcileSubscriptionStateFromRest(restState({ unsubscribeDetectedAtMs: Date.parse('2026-08-03T00:00:00Z') }), { supabase: client, now: NOW });
    expect(rows[0].cancelled_at).toBe('2026-08-03T00:00:00.000Z'); // preserved
    expect(rows[0].auto_renew).toBe(false);
  });

  it('SANDBOX in production is APPLIED for an allowlisted tester', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.REVENUECAT_SANDBOX_TEST_USER_IDS = VALID_USER_ID;
    const { client, inserts } = makeReconcileMock({ planIdForProduct: PLUS_PLAN_ID });
    const outcome = await reconcileSubscriptionStateFromRest(restState({ productId: PLUS_PRODUCT, environment: 'SANDBOX' }), { supabase: client, now: NOW });
    expect(outcome.ok).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it('SANDBOX in production is BLOCKED (no write) for a non-allowlisted user', async () => {
    process.env.VERCEL_ENV = 'production';
    // allowlist unset
    const { client, inserts, updates } = makeReconcileMock({ planIdForProduct: PLUS_PLAN_ID });
    const outcome = await reconcileSubscriptionStateFromRest(restState({ environment: 'SANDBOX' }), { supabase: client, now: NOW });
    expect(outcome).toEqual({ ok: false, reason: 'sandbox_blocked_in_production' });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('a PRODUCTION (non-sandbox) subscription reconciles normally on the production deployment', async () => {
    process.env.VERCEL_ENV = 'production';
    const { client, inserts } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    const outcome = await reconcileSubscriptionStateFromRest(restState({ environment: 'PRODUCTION' }), { supabase: client, now: NOW });
    expect(outcome.ok).toBe(true);
    expect(inserts).toHaveLength(1);
  });

  it('an unknown product resolves no plan and writes nothing', async () => {
    const { client, inserts } = makeReconcileMock({ planIdForProduct: null });
    const outcome = await reconcileSubscriptionStateFromRest(restState({ productId: 'not.a.real.product' }), { supabase: client, now: NOW });
    expect(outcome).toEqual({ ok: false, reason: 'unknown_product' });
    expect(inserts).toHaveLength(0);
  });

  it('an invalid app_user_id writes nothing', async () => {
    const { client, inserts } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    const outcome = await reconcileSubscriptionStateFromRest(restState({ appUserId: 'not-a-uuid' }), { supabase: client, now: NOW });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_app_user_id' });
    expect(inserts).toHaveLength(0);
  });

  it('unsubscribe_detected_at only flips auto_renew (never cancelled_at) — REST cannot tell a real cancel from a deferred downgrade', async () => {
    const { client, inserts } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    await reconcileSubscriptionStateFromRest(
      restState({ unsubscribeDetectedAtMs: Date.parse('2026-08-15T00:00:00Z') }),
      { supabase: client, now: NOW },
    );
    expect(inserts[0].status).toBe('active'); // access continues until ends_at
    expect(inserts[0].auto_renew).toBe(false); // won't auto-renew as-is
    // cancelled_at/pending_plan_id are owned by the CANCELLATION/PRODUCT_CHANGE
    // webhooks, never inferred from a REST unsubscribe flag (that was the
    // "Assinatura cancelada" bug for a pending downgrade).
    expect(inserts[0].cancelled_at).toBeUndefined();
    expect(inserts[0].pending_plan_id).toBeUndefined();
  });

  it('a normally-renewing subscription reconciles with auto_renew true', async () => {
    const { client, inserts } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    await reconcileSubscriptionStateFromRest(restState({ unsubscribeDetectedAtMs: null }), { supabase: client, now: NOW });
    expect(inserts[0].status).toBe('active');
    expect(inserts[0].auto_renew).toBe(true);
  });

  it('an already-expired subscription (expires_date in the past) reconciles as expired', async () => {
    const { client, inserts } = makeReconcileMock({ planIdForProduct: ESSENCIAL_PLAN_ID });
    const outcome = await reconcileSubscriptionStateFromRest(
      restState({ expiresDateMs: Date.parse('2026-08-02T00:00:00Z') }), // before NOW (2026-08-05)
      { supabase: client, now: NOW },
    );
    expect(outcome).toEqual({ ok: true, action: 'reconciled_expired' });
    expect(inserts[0].status).toBe('expired');
  });

  it('reconciling an EXPIRED row clears any pending change — an ended product can carry no scheduled change (orphan-pending guard)', async () => {
    const { client, rows } = makeReconcileMock({
      planIdForProduct: PLUS_PLAN_ID,
      // A Plus row that still carries a pending downgrade from its active life.
      seed: [{ user_id: VALID_USER_ID, plan_id: PLUS_PLAN_ID, origin: 'subscription', status: 'active', starts_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-08-02T00:00:00.000Z', pending_plan_id: ESSENCIAL_PLAN_ID, pending_effective_at: '2026-08-02T00:00:00.000Z', idempotency_key: `revenuecat:subscription:reconcile:${VALID_USER_ID}:${PLUS_PRODUCT}` }],
    });
    // Now the store reports it expired (expires in the past vs NOW).
    await reconcileSubscriptionStateFromRest(
      restState({ productId: PLUS_PRODUCT, expiresDateMs: Date.parse('2026-08-02T00:00:00Z') }),
      { supabase: client, now: NOW },
    );
    expect(rows[0].status).toBe('expired');
    expect(rows[0].pending_plan_id).toBeNull();
    expect(rows[0].pending_effective_at).toBeNull();
  });
});

// ── PRODUCT_CHANGE → pending plan (the deferred-downgrade model) ─────────────
// (PLUS_PLAN_ID / PLUS_PRODUCT already declared above for the reconcile tests.)
const ESSENCIAL_PRODUCT = 'orodim.subscription.essential.monthly';

/** Mock that resolves BOTH plan-id-by-product (`.or().maybeSingle()`) and
 *  price-by-id (`.eq('id',...).maybeSingle()`), so PRODUCT_CHANGE can compare
 *  tiers. Essencial=3490, Plus=5990. */
function makeProductChangeMock() {
  const upsertCalls: Array<{ row: Record<string, unknown> }> = [];
  const planIdFor = (filter: string) => (filter.includes('plus') ? PLUS_PLAN_ID : ESSENCIAL_PLAN_ID);
  const priceFor = (id: string) => (id === PLUS_PLAN_ID ? 5990 : 3490);
  return {
    client: {
      from: (table: string) => {
        if (table === 'plans') {
          return {
            select: () => ({
              or: (filter: string) => ({ maybeSingle: () => Promise.resolve({ data: { id: planIdFor(filter) }, error: null }) }),
              eq: (_col: string, id: string) => ({ maybeSingle: () => Promise.resolve({ data: { monthly_price_cents: priceFor(id) }, error: null }) }),
            }),
          };
        }
        if (table === 'user_plan_assignments') {
          return { upsert: (row: Record<string, unknown>) => { upsertCalls.push({ row }); return Promise.resolve({ data: null, error: null }); } };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as any,
    upsertCalls,
  };
}

describe('syncSubscriptionFromEvent — PRODUCT_CHANGE pending plan', () => {
  it('deferred DOWNGRADE (Plus→Essencial): current row stays Plus + schedules the pending Essencial at period end, never cancelled', async () => {
    const { client, upsertCalls } = makeProductChangeMock();
    await syncSubscriptionFromEvent(
      baseEvent({
        type: 'PRODUCT_CHANGE',
        productId: PLUS_PRODUCT,
        newProductId: ESSENCIAL_PRODUCT,
        expirationAtMs: Date.parse('2026-09-01T00:00:00Z'),
      }),
      { supabase: client },
    );
    const row = upsertCalls[0].row;
    expect(row.plan_id).toBe(PLUS_PLAN_ID);        // current plan unchanged
    expect(row.status).toBe('active');
    expect(row.pending_plan_id).toBe(ESSENCIAL_PLAN_ID);
    expect(row.pending_effective_at).toBe('2026-09-01T00:00:00.000Z'); // current period end
    expect(row.auto_renew).toBe(false);
    expect(row.cancelled_at).toBeUndefined();      // never a cancellation
  });

  it('immediate UPGRADE (Essencial→Plus): no pending change lingers on the old row', async () => {
    const { client, upsertCalls } = makeProductChangeMock();
    await syncSubscriptionFromEvent(
      baseEvent({ type: 'PRODUCT_CHANGE', productId: ESSENCIAL_PRODUCT, newProductId: PLUS_PRODUCT }),
      { supabase: client },
    );
    const row = upsertCalls[0].row;
    expect(row.pending_plan_id).toBeNull();
    expect(row.pending_effective_at).toBeNull();
    expect(row.auto_renew).toBe(true);
  });

  it('a RENEWAL of the target clears any pending change (downgrade has effected)', async () => {
    const { client, upsertCalls } = makeProductChangeMock();
    await syncSubscriptionFromEvent(
      baseEvent({ type: 'RENEWAL', productId: ESSENCIAL_PRODUCT }),
      { supabase: client },
    );
    const row = upsertCalls[0].row;
    expect(row.plan_id).toBe(ESSENCIAL_PLAN_ID);
    expect(row.pending_plan_id).toBeNull();
    expect(row.auto_renew).toBe(true);
  });

  it('an EXPIRATION event marks the row expired AND clears any pending change (orphan-pending guard)', async () => {
    const { client, upsertCalls } = makeProductChangeMock();
    await syncSubscriptionFromEvent(
      baseEvent({ type: 'EXPIRATION', productId: PLUS_PRODUCT }),
      { supabase: client },
    );
    const row = upsertCalls[0].row;
    expect(row.status).toBe('expired');
    expect(row.pending_plan_id).toBeNull();
    expect(row.pending_effective_at).toBeNull();
  });
});
