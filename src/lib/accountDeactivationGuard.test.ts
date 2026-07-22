import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEndSessionAfterAccountBlocked = vi.fn().mockResolvedValue(undefined);
vi.mock('./accountSessionCleanup', () => ({
  endSessionAfterAccountBlocked: mockEndSessionAfterAccountBlocked,
}));

function makeResponse(status: number, body: unknown) {
  return { status, clone: () => ({ json: async () => body }) } as unknown as Response;
}

async function installFreshGuard(fetchImpl: (...args: unknown[]) => Promise<Response>) {
  (globalThis as any).window = { fetch: fetchImpl };
  vi.resetModules();
  const mod = await import('./accountDeactivationGuard');
  mod.installAccountDeactivationGuard();
  return (globalThis as any).window.fetch as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('installAccountDeactivationGuard', () => {
  it('lets a normal response through unchanged and never signs out', async () => {
    const rawFetch = vi.fn().mockResolvedValue(makeResponse(200, { ok: true }));
    const wrappedFetch = await installFreshGuard(rawFetch);
    const res = await wrappedFetch('/api/x');
    expect(res.status).toBe(200);
    expect(mockEndSessionAfterAccountBlocked).not.toHaveBeenCalled();
  });

  it('signs out when a 403 ACCOUNT_DEACTIVATED response is observed on any request', async () => {
    const rawFetch = vi.fn().mockResolvedValue(makeResponse(403, { code: 'ACCOUNT_DEACTIVATED', message: 'x' }));
    const wrappedFetch = await installFreshGuard(rawFetch);
    await wrappedFetch('/api/whatever');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockEndSessionAfterAccountBlocked).toHaveBeenCalledTimes(1);
  });

  it('ignores a 403 that is not the ACCOUNT_DEACTIVATED signal', async () => {
    const rawFetch = vi.fn().mockResolvedValue(makeResponse(403, { code: 'FEATURE_DISABLED' }));
    const wrappedFetch = await installFreshGuard(rawFetch);
    await wrappedFetch('/api/x');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockEndSessionAfterAccountBlocked).not.toHaveBeenCalled();
  });

  it('ignores a 403 with a non-JSON body instead of throwing', async () => {
    const rawFetch = vi.fn().mockResolvedValue({
      status: 403,
      clone: () => ({ json: async () => { throw new Error('not json'); } }),
    } as unknown as Response);
    const wrappedFetch = await installFreshGuard(rawFetch);
    await expect(wrappedFetch('/api/x')).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockEndSessionAfterAccountBlocked).not.toHaveBeenCalled();
  });

  it('installing twice on the same window only wraps fetch once', async () => {
    const rawFetch = vi.fn().mockResolvedValue(makeResponse(200, {}));
    (globalThis as any).window = { fetch: rawFetch };
    vi.resetModules();
    const mod = await import('./accountDeactivationGuard');
    mod.installAccountDeactivationGuard();
    const wrappedOnce = (globalThis as any).window.fetch;
    mod.installAccountDeactivationGuard();
    expect((globalThis as any).window.fetch).toBe(wrappedOnce);
  });
});
