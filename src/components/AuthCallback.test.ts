import { describe, it, expect, vi } from 'vitest';

// AuthCallback.tsx imports the real Supabase client at module load (which calls
// createClient and throws without env). decideCallback is pure and needs none
// of it, so stub the client to keep this test env-independent.
vi.mock('../lib/supabase', () => ({ supabase: { auth: {} } }));

import { decideCallback } from './AuthCallback';

describe('decideCallback', () => {
  it('goes Home when a session already exists (implicit hash already consumed)', () => {
    expect(decideCallback({ search: '', hash: '', hasSession: true })).toEqual({ kind: 'done' });
  });

  it('waits when the implicit hash has tokens but the session is not set yet', () => {
    // signInWithOAuth (implicit) lands here with tokens in the hash; there is
    // no ?code=, and detectSessionInUrl has not finished — the OLD bug showed
    // "Link de acesso inválido" here. Now it must WAIT, not error.
    expect(
      decideCallback({
        search: '',
        hash: '#access_token=abc&refresh_token=def&token_type=bearer',
        hasSession: false,
      }),
    ).toEqual({ kind: 'wait' });
  });

  it('exchanges a PKCE ?code= when there is no session yet', () => {
    expect(decideCallback({ search: '?code=xyz', hash: '', hasSession: false })).toEqual({
      kind: 'exchange',
      code: 'xyz',
    });
  });

  it('surfaces a provider error from the query string', () => {
    expect(
      decideCallback({ search: '?error=access_denied&error_description=User+denied', hash: '', hasSession: false }),
    ).toEqual({ kind: 'error', message: 'User denied' });
  });

  it('surfaces a provider error from the hash', () => {
    expect(
      decideCallback({ search: '', hash: '#error=access_denied&error_code=otp_expired', hasSession: false }),
    ).toEqual({ kind: 'error', message: 'access_denied' });
  });

  it('prefers a real error over an existing session (do not silently proceed)', () => {
    expect(
      decideCallback({ search: '?error_description=boom', hash: '', hasSession: true }),
    ).toEqual({ kind: 'error', message: 'boom' });
  });

  it('with nothing useful, waits rather than declaring the link invalid', () => {
    expect(decideCallback({ search: '', hash: '', hasSession: false })).toEqual({ kind: 'wait' });
  });
});
