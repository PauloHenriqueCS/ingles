import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted spies so the vi.mock factories (which are hoisted above imports) can
// reference them safely.
const { signInWithOAuthMock, signInWithIdTokenMock, rememberMock, isNativeMock, isPluginMock } =
  vi.hoisted(() => ({
    signInWithOAuthMock: vi.fn(),
    signInWithIdTokenMock: vi.fn(),
    rememberMock: vi.fn(),
    isNativeMock: vi.fn(() => false),
    isPluginMock: vi.fn(() => false),
  }));

vi.mock('./supabase', () => ({
  supabase: { auth: { signInWithOAuth: signInWithOAuthMock, signInWithIdToken: signInWithIdTokenMock } },
}));
vi.mock('./authMethodMemory', () => ({ rememberAuthMethod: rememberMock }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: isNativeMock, isPluginAvailable: isPluginMock },
}));

import {
  signInWithGoogle,
  isGoogleSignInAvailable,
  classifySupabaseError,
  isUserCancellation,
} from './googleAuth';

beforeEach(() => {
  vi.clearAllMocks();
  isNativeMock.mockReturnValue(false);
  isPluginMock.mockReturnValue(false);
  vi.stubGlobal('window', { location: { origin: 'https://app.orodim.com.br' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifySupabaseError', () => {
  it('maps connectivity messages to network', () => {
    expect(classifySupabaseError('Failed to fetch')).toBe('network');
    expect(classifySupabaseError('request timeout')).toBe('network');
  });
  it('maps token/nonce messages to invalid_token', () => {
    expect(classifySupabaseError('Nonce mismatch')).toBe('invalid_token');
    expect(classifySupabaseError('invalid audience (aud)')).toBe('invalid_token');
    expect(classifySupabaseError('JWT expired')).toBe('invalid_token');
  });
  it('falls back to unknown', () => {
    expect(classifySupabaseError('something odd happened')).toBe('unknown');
  });
});

describe('isUserCancellation', () => {
  it('recognizes the many cancel shapes', () => {
    expect(isUserCancellation(new Error('The user canceled the sign-in'))).toBe(true);
    expect(isUserCancellation('Sign in cancelled')).toBe(true);
    expect(isUserCancellation(new Error('12501'))).toBe(true);
    expect(isUserCancellation(new Error('No credential available'))).toBe(true);
  });
  it('does not treat real errors as cancellations', () => {
    expect(isUserCancellation(new Error('network unreachable'))).toBe(false);
  });
});

describe('isGoogleSignInAvailable', () => {
  it('is always offerable on web', () => {
    isNativeMock.mockReturnValue(false);
    expect(isGoogleSignInAvailable()).toBe(true);
  });
  it('is unavailable on native without the plugin/client id', () => {
    isNativeMock.mockReturnValue(true);
    isPluginMock.mockReturnValue(false);
    expect(isGoogleSignInAvailable()).toBe(false);
  });
});

describe('signInWithGoogle (web redirect path)', () => {
  it('starts the OAuth redirect to /auth/callback and remembers the method', async () => {
    signInWithOAuthMock.mockResolvedValue({ data: {}, error: null });

    const result = await signInWithGoogle();

    expect(result).toEqual({ ok: true });
    expect(signInWithOAuthMock).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'https://app.orodim.com.br/auth/callback' },
    });
    expect(rememberMock).toHaveBeenCalledWith('google');
    // The native id-token path must never run on web.
    expect(signInWithIdTokenMock).not.toHaveBeenCalled();
  });

  it('classifies a Supabase error and does not remember the method', async () => {
    signInWithOAuthMock.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });

    const result = await signInWithGoogle();

    expect(result).toEqual({ ok: false, reason: 'network', message: 'Failed to fetch' });
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('never throws — an unexpected rejection becomes an unknown failure', async () => {
    signInWithOAuthMock.mockRejectedValue(new Error('boom'));

    const result = await signInWithGoogle();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
    expect(rememberMock).not.toHaveBeenCalled();
  });
});
