/**
 * POST /api/account/deactivate (api/account/deactivate.ts).
 *
 * Covers the request-shape/security contract described in the task:
 *  - Only POST is allowed
 *  - Unauthenticated requests never reach the deactivation flow
 *  - The route calls requireAuth with allowDeactivated:true (it must stay
 *    reachable — idempotently — after the account is already deactivated)
 *  - The userId passed to deactivateAccount always comes from requireAuth's
 *    session-derived context, never from anything in req.body (a body with
 *    a spoofed user_id is simply ignored — the handler never reads req.body
 *    at all)
 *  - Rate limiting blocks before the flow runs
 *  - Success returns exactly {success:true, status:'deactivated'}
 *  - A thrown error from the flow never reports success, and is audited
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockApplyRateLimit, mockDeactivateAccount, mockRecordAccountAuditEvent } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockApplyRateLimit: vi.fn(),
  mockDeactivateAccount: vi.fn(),
  mockRecordAccountAuditEvent: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit, RATE_LIMITS: {} }));
vi.mock('../_account/deactivate-account', () => ({ deactivateAccount: mockDeactivateAccount }));
vi.mock('../_account/audit', () => ({ recordAccountAuditEvent: mockRecordAccountAuditEvent }));

import handler from '../account/deactivate';

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    _status: () => _status,
    _body: () => _body,
  };
  return res;
}

function makeReq(overrides: Partial<{ method: string; headers: Record<string, string>; body: unknown }> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApplyRateLimit.mockResolvedValue(true);
});

it('rejects non-POST methods without touching auth', async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res as any);
  expect(res._status()).toBe(405);
  expect(mockRequireAuth).not.toHaveBeenCalled();
});

it('propagates a 401 from requireAuth and never calls the deactivation flow', async () => {
  mockRequireAuth.mockResolvedValue(null);
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(mockDeactivateAccount).not.toHaveBeenCalled();
  expect(mockApplyRateLimit).not.toHaveBeenCalled();
});

it('calls requireAuth with allowDeactivated:true so retries after deactivation still work', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'user-1', accessToken: 'tok-1', supabase: {} });
  mockDeactivateAccount.mockResolvedValue({ status: 'deactivated', alreadyDeactivated: false });
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(mockRequireAuth).toHaveBeenCalledWith(expect.anything(), expect.anything(), { allowDeactivated: true });
});

it('ignores any user_id spoofed in the request body — always uses the session userId', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'real-user', accessToken: 'tok-1', supabase: {} });
  mockDeactivateAccount.mockResolvedValue({ status: 'deactivated', alreadyDeactivated: false });
  const res = makeRes();
  await handler(makeReq({ body: { userId: 'someone-elses-id', user_id: 'someone-elses-id' } }), res as any);
  expect(mockDeactivateAccount).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'real-user', accessToken: 'tok-1' }),
  );
});

it('blocks on rate limit before calling the deactivation flow', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'user-1', accessToken: 'tok-1', supabase: {} });
  mockApplyRateLimit.mockImplementation(async (r: any) => {
    r.status(429).json({ code: 'RATE_LIMITED', message: 'Too many' });
    return false;
  });
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(res._status()).toBe(429);
  expect(mockDeactivateAccount).not.toHaveBeenCalled();
});

it('returns exactly {success:true, status:"deactivated"} on success, with no personal data', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'user-1', accessToken: 'tok-1', supabase: {} });
  mockDeactivateAccount.mockResolvedValue({ status: 'deactivated', alreadyDeactivated: false });
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(res._status()).toBe(200);
  expect(res._body()).toEqual({ success: true, status: 'deactivated' });
});

it('is idempotent: a repeated call after the account is already deactivated still succeeds', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'user-1', accessToken: 'tok-1', supabase: {} });
  mockDeactivateAccount.mockResolvedValue({ status: 'deactivated', alreadyDeactivated: true });
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(res._status()).toBe(200);
  expect(res._body()).toEqual({ success: true, status: 'deactivated' });
});

it('never declares success when the deactivation flow throws, and records an audit failure', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'user-1', accessToken: 'tok-1', supabase: {} });
  mockDeactivateAccount.mockRejectedValue(new Error('db exploded'));
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(res._status()).toBe(500);
  expect((res._body() as any).code).toBe('INTERNAL_ERROR');
  expect((res._body() as any).success).toBeUndefined();
  expect(mockRecordAccountAuditEvent).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'user-1', action: 'account.deactivated', result: 'failure' }),
  );
});

it('never leaks the raw error message to the client', async () => {
  mockRequireAuth.mockResolvedValue({ userId: 'user-1', accessToken: 'tok-1', supabase: {} });
  mockDeactivateAccount.mockRejectedValue(new Error('SUPABASE_SERVICE_ROLE_KEY=sk-secret leaked'));
  const res = makeRes();
  await handler(makeReq(), res as any);
  expect(JSON.stringify(res._body())).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  expect(JSON.stringify(res._body())).not.toContain('sk-secret');
});
