/**
 * Endpoint tests for GET /api/conversation/minute-packages
 * (api/conversation/[...slug].ts -> handleMinutePackages).
 *
 * Covers the required personas from the ticket — Essencial, Plus, Trial —
 * plus the two catalog-eligibility cases (inactive package, unpublished
 * package) and the standard auth/method/error guards every route in this
 * dispatcher already follows. Never trusts the client for plan or
 * eligibility: entitlements come from a mocked
 * getCurrentUserPlanEntitlements (same resolver /session uses), and the
 * catalog comes from a fake service-role Supabase client standing in for
 * getSharedServiceClient(), which really applies the active/published
 * filters (not a passthrough stub).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockPackagesFrom } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockPackagesFrom: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));
vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getSharedServiceClient: () => ({ from: mockPackagesFrom }) };
});

import handler from '../conversation/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000099';

interface FixtureRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  minutes: number;
  price_cents: number;
  currency: string;
  compatible_plan_codes: string[] | null;
  display_order: number;
  active: boolean;
  status: string;
}

function packageRow(overrides: Partial<FixtureRow> & { id: string; code: string }): FixtureRow {
  return {
    name: `Pacote ${overrides.code}`,
    description: null,
    minutes: 60,
    price_cents: 1990,
    currency: 'BRL',
    compatible_plan_codes: null,
    display_order: 0,
    active: true,
    status: 'published',
    ...overrides,
  };
}

/** Real filtering (not a passthrough) so the endpoint test genuinely proves
 *  active/published/compatibility are enforced end-to-end through the route. */
function setCatalog(rows: FixtureRow[]) {
  mockPackagesFrom.mockImplementation((table: string) => {
    expect(table).toBe('conversation_minute_packages');
    let filtered = [...rows];
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => (r as any)[col] === val);
        return builder;
      },
      order: (col: string, options?: { ascending?: boolean }) => {
        const dir = options?.ascending === false ? -1 : 1;
        filtered = [...filtered].sort((a, b) => {
          const av = (a as any)[col];
          const bv = (b as any)[col];
          return av > bv ? dir : av < bv ? -dir : 0;
        });
        return Promise.resolve({ data: filtered, error: null });
      },
    };
    return builder;
  });
}

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' | 'lifetime' = 'month'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}

function entitlementsFor(planCode: string, extraPurchaseEnabled: boolean): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode, planName: planCode, planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: {
      enabled: true,
      monthlyTime: permissiveLimit(planCode === 'trial' ? 'lifetime' : 'month'),
      maxRecordingSeconds: 0,
      maxRecordingUnlimited: true,
      extraPurchaseEnabled,
      extraSecondsAvailable: 0,
    },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'GET', url: '/api/conversation/minute-packages', headers: { authorization: 'Bearer test-token' }, ...overrides };
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  setCatalog([]);
});

describe('GET /api/conversation/minute-packages', () => {
  it('usuário Essencial: purchaseAvailable=true and returns compatible published+active packages', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('essential', true));
    setCatalog([
      packageRow({ id: '1', code: 'extra-60', minutes: 60, price_cents: 1990, compatible_plan_codes: null }),
      packageRow({ id: '2', code: 'essential-only', minutes: 30, price_cents: 990, compatible_plan_codes: ['essential'] }),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    const body = res._body() as { purchaseAvailable: boolean; packages: unknown[] };
    expect(body.purchaseAvailable).toBe(true);
    expect(body.packages).toEqual([
      { id: '1', code: 'extra-60', name: 'Pacote extra-60', description: null, minutes: 60, priceCents: 1990, currency: 'BRL' },
      { id: '2', code: 'essential-only', name: 'Pacote essential-only', description: null, minutes: 30, priceCents: 990, currency: 'BRL' },
    ]);
  });

  it('usuário Plus (extra_purchase_enabled=false no plano): purchaseAvailable=false and never queries the catalog', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('plus', false));
    setCatalog([packageRow({ id: '1', code: 'extra-60' })]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ purchaseAvailable: false, packages: [] });
    expect(mockPackagesFrom).not.toHaveBeenCalled();
  });

  it('usuário Plus (extra_purchase_enabled=true no plano): applies per-package plan compatibility', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('plus', true));
    setCatalog([
      packageRow({ id: '1', code: 'any-plan', compatible_plan_codes: null }),
      packageRow({ id: '2', code: 'essential-only', compatible_plan_codes: ['essential'] }),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res._body() as { purchaseAvailable: boolean; packages: { code: string }[] };
    expect(body.purchaseAvailable).toBe(true);
    expect(body.packages.map((p) => p.code)).toEqual(['any-plan']);
  });

  it('usuário Trial: purchaseAvailable=false and never queries the catalog, even if extra_purchase_enabled somehow resolves true', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('trial', true));
    setCatalog([packageRow({ id: '1', code: 'extra-60' })]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ purchaseAvailable: false, packages: [] });
    expect(mockPackagesFrom).not.toHaveBeenCalled();
  });

  it('pacote inativo: excluded even when published and plan-compatible', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('essential', true));
    setCatalog([
      packageRow({ id: '1', code: 'active-one', active: true, status: 'published' }),
      packageRow({ id: '2', code: 'inactive-one', active: false, status: 'published' }),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res._body() as { packages: { code: string }[] };
    expect(body.packages.map((p) => p.code)).toEqual(['active-one']);
  });

  it('pacote não publicado: excluded even when active and plan-compatible', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('essential', true));
    setCatalog([
      packageRow({ id: '1', code: 'published-one', active: true, status: 'published' }),
      packageRow({ id: '2', code: 'draft-one', active: true, status: 'draft' }),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    const body = res._body() as { packages: { code: string }[] };
    expect(body.packages.map((p) => p.code)).toEqual(['published-one']);
  });

  it('never resolves entitlements or queries the catalog when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue(null);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockGetCurrentUserPlanEntitlements).not.toHaveBeenCalled();
    expect(mockPackagesFrom).not.toHaveBeenCalled();
  });

  it('returns 405 for a non-GET method', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('essential', true));

    const res = makeRes();
    await handler(makeReq({ method: 'POST' }), res);

    expect(res._status()).toBe(405);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('returns 500 INTERNAL_ERROR when entitlements resolution fails, never querying the catalog', async () => {
    mockGetCurrentUserPlanEntitlements.mockRejectedValue(new Error('db down'));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(500);
    expect((res._body() as { code: string }).code).toBe('INTERNAL_ERROR');
    expect(mockPackagesFrom).not.toHaveBeenCalled();
  });

  it('returns 500 INTERNAL_ERROR when the catalog read fails', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsFor('essential', true));
    mockPackagesFrom.mockImplementation((table: string) => {
      expect(table).toBe('conversation_minute_packages');
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
      };
      return builder;
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(500);
    expect((res._body() as { code: string }).code).toBe('INTERNAL_ERROR');
  });
});
