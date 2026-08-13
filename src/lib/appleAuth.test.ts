import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  signInWithOAuthMock,
  signInWithIdTokenMock,
  rememberMock,
  getPlatformMock,
  isNativeMock,
  isPluginMock,
} = vi.hoisted(() => ({
  signInWithOAuthMock: vi.fn(),
  signInWithIdTokenMock: vi.fn(),
  rememberMock: vi.fn(),
  getPlatformMock: vi.fn(() => 'web'),
  isNativeMock: vi.fn(() => false),
  isPluginMock: vi.fn(() => false),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { signInWithOAuth: signInWithOAuthMock, signInWithIdToken: signInWithIdTokenMock } },
}));
vi.mock('./authMethodMemory', () => ({ rememberAuthMethod: rememberMock }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: getPlatformMock,
    isNativePlatform: isNativeMock,
    isPluginAvailable: isPluginMock,
  },
}));

import {
  signInWithApple,
  isAppleSignInAvailable,
  classifySupabaseError,
  isUserCancellation,
} from './appleAuth';

beforeEach(() => {
  vi.clearAllMocks();
  getPlatformMock.mockReturnValue('web');
  isNativeMock.mockReturnValue(false);
  isPluginMock.mockReturnValue(false);
  vi.stubGlobal('window', { location: { origin: 'https://app.orodim.com.br' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifySupabaseError', () => {
  it('maps connectivity and token errors', () => {
    expect(classifySupabaseError('Failed to fetch')).toBe('network');
    expect(classifySupabaseError('nonce mismatch')).toBe('invalid_token');
    expect(classifySupabaseError('weird')).toBe('unknown');
  });
});

describe('isUserCancellation', () => {
  it('treats Apple cancel (1001) and canceled text as cancellation', () => {
    expect(isUserCancellation(new Error('The operation was canceled'))).toBe(true);
    expect(isUserCancellation(new Error('ASAuthorizationError 1001'))).toBe(true);
    expect(isUserCancellation(new Error('network down'))).toBe(false);
  });
});

describe('isAppleSignInAvailable', () => {
  it('is hidden on web until the flag is enabled (default off in tests)', () => {
    getPlatformMock.mockReturnValue('web');
    isNativeMock.mockReturnValue(false);
    expect(isAppleSignInAvailable()).toBe(false);
  });
  it('is available on iOS when the plugin (entitlement) is present', () => {
    getPlatformMock.mockReturnValue('ios');
    isNativeMock.mockReturnValue(true);
    isPluginMock.mockReturnValue(true);
    expect(isAppleSignInAvailable()).toBe(true);
  });
  it('is unavailable on iOS without the plugin', () => {
    getPlatformMock.mockReturnValue('ios');
    isNativeMock.mockReturnValue(true);
    isPluginMock.mockReturnValue(false);
    expect(isAppleSignInAvailable()).toBe(false);
  });
  it('is never offered on native Android', () => {
    getPlatformMock.mockReturnValue('android');
    isNativeMock.mockReturnValue(true);
    expect(isAppleSignInAvailable()).toBe(false);
  });
});

describe('signInWithApple (web redirect path)', () => {
  it('starts the OAuth redirect to /auth/callback and remembers the method', async () => {
    signInWithOAuthMock.mockResolvedValue({ data: {}, error: null });

    const result = await signInWithApple();

    expect(result).toEqual({ ok: true });
    expect(signInWithOAuthMock).toHaveBeenCalledWith({
      provider: 'apple',
      options: { redirectTo: 'https://app.orodim.com.br/auth/callback' },
    });
    expect(rememberMock).toHaveBeenCalledWith('apple');
    expect(signInWithIdTokenMock).not.toHaveBeenCalled();
  });

  it('classifies a Supabase error and does not remember the method', async () => {
    signInWithOAuthMock.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });

    const result = await signInWithApple();

    expect(result).toEqual({ ok: false, reason: 'network', message: 'Failed to fetch' });
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('never throws — an unexpected rejection becomes an unknown failure', async () => {
    signInWithOAuthMock.mockRejectedValue(new Error('boom'));

    const result = await signInWithApple();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});
