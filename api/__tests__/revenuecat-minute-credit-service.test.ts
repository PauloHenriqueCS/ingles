import { describe, it, expect, afterEach } from 'vitest';
import { creditMinutePackagePurchase, type RevenueCatConsumablePurchaseEvent } from '../_billing/revenuecat-minute-credit-service';

const VALID_USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

interface MockOptions {
  packageRow?: { minutes: number; active: boolean; status: string } | null;
  packageError?: { message: string } | null;
  planCode?: string | null;
  insertError?: { code?: string; message: string } | null;
}

function makeMockSupabase(opts: MockOptions = {}) {
  const insertCalls: Array<Record<string, unknown>> = [];
  return {
    client: {
      from: (table: string) => {
        if (table === 'conversation_minute_packages') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: opts.packageRow ?? null, error: opts.packageError ?? null }),
              }),
            }),
          };
        }
        if (table === 'user_conversation_credits') {
          return {
            insert: (row: Record<string, unknown>) => {
              insertCalls.push(row);
              return Promise.resolve({ data: null, error: opts.insertError ?? null });
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
      rpc: () => Promise.resolve({ data: [{ plan_code: opts.planCode ?? 'essencial' }], error: null }),
    } as any,
    insertCalls,
  };
}

function basePurchase(overrides: Partial<RevenueCatConsumablePurchaseEvent> = {}): RevenueCatConsumablePurchaseEvent {
  return {
    appUserId: VALID_USER_ID,
    environment: 'PRODUCTION',
    // Default to Google Play so the production-sandbox gate test keeps
    // exercising the allowlist path; Apple sandbox has its own bypass (below).
    store: 'play_store',
    productId: 'orodim.conversation.minutes.300',
    transactionId: 'txn-consumable-1',
    ...overrides,
  };
}

const originalVercelEnv = process.env.VERCEL_ENV;
afterEach(() => {
  process.env.VERCEL_ENV = originalVercelEnv;
});

describe('creditMinutePackagePurchase — 300/600/900 minute packages', () => {
  it('300 minutes: credits 300*60 seconds, source=purchase, external_reference=transactionId', async () => {
    const { client, insertCalls } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'published' } });
    const outcome = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'credited', minutes: 300 });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      user_id: VALID_USER_ID,
      total_seconds: 18000,
      remaining_seconds: 18000,
      source: 'purchase',
      external_reference: 'txn-consumable-1',
      created_by: VALID_USER_ID,
    });
  });

  it('600 minutes: credits 600*60 seconds', async () => {
    const { client, insertCalls } = makeMockSupabase({ packageRow: { minutes: 600, active: true, status: 'published' } });
    await creditMinutePackagePurchase(basePurchase({ productId: 'orodim.conversation.minutes.600' }), { supabase: client });
    expect(insertCalls[0].total_seconds).toBe(36000);
  });

  it('900 minutes: credits 900*60 seconds', async () => {
    const { client, insertCalls } = makeMockSupabase({ packageRow: { minutes: 900, active: true, status: 'published' } });
    await creditMinutePackagePurchase(basePurchase({ productId: 'orodim.conversation.minutes.900' }), { supabase: client });
    expect(insertCalls[0].total_seconds).toBe(54000);
  });
});

describe('creditMinutePackagePurchase — idempotency', () => {
  it('a duplicate transaction (unique-index violation, Postgres 23505) is an idempotent success, never a failure', async () => {
    const { client } = makeMockSupabase({
      packageRow: { minutes: 300, active: true, status: 'published' },
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const outcome = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'already_credited' });
  });

  it('a repeated webhook delivery of the same purchase never doubles the credited amount (same idempotency contract as above)', async () => {
    const { client } = makeMockSupabase({
      packageRow: { minutes: 300, active: true, status: 'published' },
      insertError: { code: '23505', message: 'duplicate' },
    });
    const first = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    const second = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second as { action: string }).action).toBe('already_credited');
  });

  it('a genuine (non-duplicate) DB error still throws — never silently swallowed', async () => {
    const { client } = makeMockSupabase({
      packageRow: { minutes: 300, active: true, status: 'published' },
      insertError: { code: '55000', message: 'connection reset' },
    });
    await expect(creditMinutePackagePurchase(basePurchase(), { supabase: client })).rejects.toThrow();
  });
});

describe('creditMinutePackagePurchase — package must be active and published', () => {
  it('rejects a draft/inactive package (e.g. today\'s real state of pacote-300/600/900-min in homolog)', async () => {
    const { client, insertCalls } = makeMockSupabase({ packageRow: { minutes: 300, active: false, status: 'draft' } });
    const outcome = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'package_not_active' });
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects an active package that is not published', async () => {
    const { client } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'archived' } });
    const outcome = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'package_not_active' });
  });

  it('rejects an unknown product id — never credits by name or guesswork', async () => {
    const { client } = makeMockSupabase({ packageRow: null });
    const outcome = await creditMinutePackagePurchase(basePurchase({ productId: 'unknown.product' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'unknown_product' });
  });
});

describe('creditMinutePackagePurchase — business rules', () => {
  it('trial users can never buy a package', async () => {
    const { client, insertCalls } = makeMockSupabase({
      packageRow: { minutes: 300, active: true, status: 'published' },
      planCode: 'trial',
    });
    const outcome = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'trial_not_allowed' });
    expect(insertCalls).toHaveLength(0);
  });

  it('Essencial/Plus users can buy', async () => {
    const { client } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'published' }, planCode: 'essencial' });
    const outcome = await creditMinutePackagePurchase(basePurchase(), { supabase: client });
    expect(outcome.ok).toBe(true);
  });

  it('rejects an invalid app_user_id', async () => {
    const { client } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'published' } });
    const outcome = await creditMinutePackagePurchase(basePurchase({ appUserId: 'not-a-uuid' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_app_user_id' });
  });

  it('rejects a purchase with no transaction id — no idempotency key to key off of', async () => {
    const { client } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'published' } });
    const outcome = await creditMinutePackagePurchase(basePurchase({ transactionId: null }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'missing_transaction_id' });
  });

  it('blocks a SANDBOX (Google Play) purchase when this deployment is production', async () => {
    process.env.VERCEL_ENV = 'production';
    const { client, insertCalls } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'published' } });
    const outcome = await creditMinutePackagePurchase(basePurchase({ environment: 'SANDBOX', store: 'play_store' }), { supabase: client });
    expect(outcome).toEqual({ ok: false, reason: 'sandbox_blocked_in_production' });
    expect(insertCalls).toHaveLength(0);
  });

  it('APP STORE + SANDBOX in production is APPLIED even for a non-allowlisted user (App Review can buy a minute package)', async () => {
    process.env.VERCEL_ENV = 'production';
    const { client, insertCalls } = makeMockSupabase({ packageRow: { minutes: 300, active: true, status: 'published' } });
    const outcome = await creditMinutePackagePurchase(basePurchase({ environment: 'SANDBOX', store: 'app_store' }), { supabase: client });
    expect(outcome).toEqual({ ok: true, action: 'credited', minutes: 300 });
    expect(insertCalls).toHaveLength(1);
  });
});
