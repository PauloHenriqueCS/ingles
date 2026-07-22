import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Vite dispatches 'vite:preloadError' on window specifically for failed
// dynamic import()/modulepreload fetches — see the module doc for why this
// is the one and only signal this recovery reacts to (never a generic
// window 'error'/'unhandledrejection' handler, so API/Azure/pronunciation
// errors are never touched by this).

type Handler = (...args: unknown[]) => void;

describe('installChunkReloadRecovery', () => {
  let listeners: Record<string, Handler[]>;
  let reloadMock: ReturnType<typeof vi.fn>;
  let alertMock: ReturnType<typeof vi.fn>;
  let storage: Map<string, string>;

  function firePreloadError() {
    for (const handler of listeners['vite:preloadError'] ?? []) handler();
  }

  beforeEach(() => {
    listeners = {};
    reloadMock = vi.fn();
    alertMock = vi.fn();
    storage = new Map();

    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: Handler) => {
        listeners[type] = listeners[type] ?? [];
        listeners[type].push(handler);
      },
      alert: alertMock,
      location: { reload: reloadMock },
    });

    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a listener for vite:preloadError specifically, no other event type', async () => {
    const { installChunkReloadRecovery } = await import('./chunkReloadRecovery');
    installChunkReloadRecovery();
    expect(Object.keys(listeners)).toEqual(['vite:preloadError']);
  });

  it('reloads the page on the first stale-chunk failure', async () => {
    const { installChunkReloadRecovery } = await import('./chunkReloadRecovery');
    installChunkReloadRecovery();
    firePreloadError();
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('does not reload a second time in the same session — shows a message instead', async () => {
    const { installChunkReloadRecovery } = await import('./chunkReloadRecovery');
    installChunkReloadRecovery();
    firePreloadError();
    firePreloadError();
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it('never loops beyond a single reload even with many repeated failures', async () => {
    const { installChunkReloadRecovery } = await import('./chunkReloadRecovery');
    installChunkReloadRecovery();
    for (let i = 0; i < 20; i++) firePreloadError();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when sessionStorage access fails (private mode, storage disabled)', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
    });
    const { installChunkReloadRecovery } = await import('./chunkReloadRecovery');
    installChunkReloadRecovery();
    expect(() => firePreloadError()).not.toThrow();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
