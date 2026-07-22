import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── sessionStorage / localStorage stubs ────────────────────────────────────

function makeStorageMock() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
}

const sessionStorageMock = makeStorageMock();
const localStorageMock = makeStorageMock();
Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorageMock, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Supabase mock ───────────────────────────────────────────────────────────

const { mockGetSession, mockSignOut } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockSignOut: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      signOut: mockSignOut,
    },
  },
}));

import {
  consumeAccountSessionNotice,
  endSessionAfterAccountDeletion,
  endSessionAfterAccountBlocked,
} from './accountSessionCleanup';

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorageMock.clear();
  localStorageMock.clear();
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
});

describe('consumeAccountSessionNotice', () => {
  it('returns null when nothing was set', () => {
    expect(consumeAccountSessionNotice()).toBeNull();
  });

  it('returns the notice once and then clears it', () => {
    sessionStorageMock.setItem('lemon.accountSessionNotice', 'deleted');
    expect(consumeAccountSessionNotice()).toBe('deleted');
    expect(consumeAccountSessionNotice()).toBeNull();
  });
});

describe('endSessionAfterAccountDeletion', () => {
  it('clears the per-user local cache, sets the "deleted" notice, and signs out', async () => {
    localStorageMock.setItem('english-calendar-entries-v2-user-1', '{"x":1}');
    await endSessionAfterAccountDeletion();
    expect(localStorageMock.getItem('english-calendar-entries-v2-user-1')).toBeNull();
    expect(sessionStorageMock.getItem('lemon.accountSessionNotice')).toBe('deleted');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('endSessionAfterAccountBlocked', () => {
  it('sets the "blocked" notice (distinct from "deleted") and signs out', async () => {
    await endSessionAfterAccountBlocked();
    expect(sessionStorageMock.getItem('lemon.accountSessionNotice')).toBe('blocked');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('still signs out even if reading the session for cache cleanup fails', async () => {
    mockGetSession.mockRejectedValue(new Error('network down'));
    await expect(endSessionAfterAccountBlocked()).resolves.toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
