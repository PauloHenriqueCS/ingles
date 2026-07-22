import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAuthHeader } = vi.hoisted(() => ({ mockGetAuthHeader: vi.fn() }));
vi.mock('./apiAuth', () => ({ getAuthHeader: mockGetAuthHeader }));

import { deactivateAccount, DeactivateAccountError } from './accountDeletion';

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).fetch = vi.fn();
});

describe('deactivateAccount', () => {
  it('throws UNAUTHORIZED without calling fetch when there is no session', async () => {
    mockGetAuthHeader.mockResolvedValue({});
    await expect(deactivateAccount()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it('POSTs to /api/account/deactivate with the session Authorization header, no user identifier', async () => {
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer tok-1' });
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, status: 'deactivated' }),
    });
    const result = await deactivateAccount();
    expect(result).toEqual({ success: true, status: 'deactivated' });

    const [url, init] = (globalThis as any).fetch.mock.calls[0];
    expect(url).toBe('/api/account/deactivate');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.body).toBeUndefined();
  });

  it('maps a 429 response to a RATE_LIMITED error', async () => {
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer tok-1' });
    (globalThis as any).fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ code: 'RATE_LIMITED', message: 'Too many' }),
    });
    await expect(deactivateAccount()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps a network failure to NETWORK_ERROR instead of throwing a raw fetch error', async () => {
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer tok-1' });
    (globalThis as any).fetch.mockRejectedValue(new Error('offline'));
    await expect(deactivateAccount()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws a DeactivateAccountError with a safe code+message on a server error', async () => {
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer tok-1' });
    (globalThis as any).fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a exclusão da conta. Tente novamente.' }),
    });
    let caught: unknown;
    try {
      await deactivateAccount();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeactivateAccountError);
    expect((caught as DeactivateAccountError).code).toBe('INTERNAL_ERROR');
  });

  it('treats an unexpected 200 body shape as a failure rather than reporting success', async () => {
    mockGetAuthHeader.mockResolvedValue({ Authorization: 'Bearer tok-1' });
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'shape' }),
    });
    await expect(deactivateAccount()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
