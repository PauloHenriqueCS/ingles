import { describe, it, expect, vi } from 'vitest';

// nativeAuthDeepLink imports appleAuth → supabase (createClient throws without
// env) and Capacitor. Stub them; parseAuthCallbackUrl is pure and needs neither.
vi.mock('./supabase', () => ({ supabase: { auth: {} } }));
vi.mock('./authMethodMemory', () => ({ rememberAuthMethod: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));

import { parseAuthCallbackUrl } from './nativeAuthDeepLink';

const CB = 'com.orodim.app://auth/callback';

describe('parseAuthCallbackUrl', () => {
  it('ignores deep links that are not our OAuth callback', () => {
    expect(parseAuthCallbackUrl('com.orodim.app://other')).toEqual({ kind: 'ignore' });
    expect(parseAuthCallbackUrl('https://example.com/auth/callback?code=x')).toEqual({ kind: 'ignore' });
    expect(parseAuthCallbackUrl('')).toEqual({ kind: 'ignore' });
  });

  it('extracts a PKCE code from the query string', () => {
    expect(parseAuthCallbackUrl(`${CB}?code=abc123`)).toEqual({ kind: 'code', code: 'abc123' });
  });

  it('PKCE-only: implicit access/refresh tokens in the hash are ignored (no session)', () => {
    // Security regression guard: a co-installed app spoofing our custom scheme
    // could deliver implicit tokens here. They must never establish a session,
    // so an implicit-token callback parses to `ignore` (never `tokens`).
    expect(
      parseAuthCallbackUrl(`${CB}#access_token=AT&refresh_token=RT&token_type=bearer&expires_in=3600`),
    ).toEqual({ kind: 'ignore' });
    // Even in the query string, tokens without a `?code=` are ignored.
    expect(
      parseAuthCallbackUrl(`${CB}?access_token=AT&refresh_token=RT`),
    ).toEqual({ kind: 'ignore' });
  });

  it('surfaces a provider error / user cancel (query or hash)', () => {
    expect(parseAuthCallbackUrl(`${CB}?error=access_denied&error_description=User+cancelled`)).toEqual({
      kind: 'error',
      message: 'User cancelled',
    });
    expect(parseAuthCallbackUrl(`${CB}#error=access_denied`)).toEqual({
      kind: 'error',
      message: 'access_denied',
    });
  });

  it('ignores a matching callback that carries nothing usable', () => {
    expect(parseAuthCallbackUrl(CB)).toEqual({ kind: 'ignore' });
  });
});
