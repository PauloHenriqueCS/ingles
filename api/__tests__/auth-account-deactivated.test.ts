/**
 * requireAuth (api/_auth.ts) — account-deactivation gate.
 *
 * This is the single chokepoint every authenticated route already goes
 * through, so this is where "a deactivated account can't use any
 * authenticated endpoint" (ACCOUNT_DEACTIVATED, 403) is enforced. Covers:
 *  - No token / invalid token still behave exactly as before (401)
 *  - A deactivated account is blocked with the documented {code, message}
 *  - An active account still receives its authed context (userId, supabase,
 *    accessToken)
 *  - allowDeactivated:true (the deactivation route's own exception) bypasses
 *    the check entirely and never even queries deactivation status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetUser, mockIsAccountDeactivated } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockIsAccountDeactivated: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

vi.mock('../_account/deactivation-status', () => ({
  isAccountDeactivated: mockIsAccountDeactivated,
}));

import { requireAuth } from '../_auth';

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    _status: () => _status,
    _body: () => _body,
  };
  return res;
}

function makeReq(token?: string) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('requireAuth', () => {
  it('returns 401 when there is no bearer token', async () => {
    const res = makeRes();
    const result = await requireAuth(makeReq(), res as any);
    expect(result).toBeNull();
    expect(res._status()).toBe(401);
    expect(mockIsAccountDeactivated).not.toHaveBeenCalled();
  });

  it('returns 401 when Supabase rejects the token', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid') });
    const res = makeRes();
    const result = await requireAuth(makeReq('bad-token'), res as any);
    expect(result).toBeNull();
    expect(res._status()).toBe(401);
    expect(mockIsAccountDeactivated).not.toHaveBeenCalled();
  });

  it('returns 403 ACCOUNT_DEACTIVATED for a deactivated account, and never returns an authed context', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockIsAccountDeactivated.mockResolvedValue(true);
    const res = makeRes();
    const result = await requireAuth(makeReq('good-token'), res as any);
    expect(result).toBeNull();
    expect(res._status()).toBe(403);
    expect(res._body()).toEqual({ code: 'ACCOUNT_DEACTIVATED', message: 'Esta conta não está disponível.' });
    expect(mockIsAccountDeactivated).toHaveBeenCalledWith('user-1');
  });

  it('returns the authed context (including the raw access token) for an active account', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockIsAccountDeactivated.mockResolvedValue(false);
    const res = makeRes();
    const result = await requireAuth(makeReq('good-token'), res as any);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(result!.accessToken).toBe('good-token');
  });

  it('bypasses the deactivation check entirely when allowDeactivated is set', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockIsAccountDeactivated.mockResolvedValue(true);
    const res = makeRes();
    const result = await requireAuth(makeReq('good-token'), res as any, { allowDeactivated: true });
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user-1');
    expect(mockIsAccountDeactivated).not.toHaveBeenCalled();
  });
});
