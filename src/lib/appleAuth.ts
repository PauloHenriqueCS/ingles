import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase';
import { rememberAuthMethod } from './authMethodMemory';

/**
 * Sign in with Apple, brokered by Supabase Auth (the session authority) so an
 * Apple user resolves to the same auth.users.id (UUID) everything else keys on —
 * exactly like googleAuth.ts. Kept as a separate, self-contained module (rather
 * than refactoring the working Google path) so adding Apple carries zero risk of
 * Google regression.
 *
 * Two runtime paths, one outcome (a Supabase session):
 *  - iOS native: obtain Apple's identity token via @capgo/capacitor-social-login
 *    (native AuthenticationServices under the hood) and call signInWithIdToken —
 *    no browser, per Apple's guidance. Requires the "Sign in with Apple"
 *    capability/entitlement on the iOS App ID.
 *  - Web (and anywhere else it is enabled): supabase.auth.signInWithOAuth,
 *    completed by the existing AuthCallback.tsx handler at /auth/callback. No
 *    Apple secret in the bundle — Supabase holds the client secret JWT.
 *
 * Availability: unlike Google (whose web path is always offerable), Apple web
 * depends on the Supabase Apple provider being configured, so the web button is
 * gated behind VITE_APPLE_SIGNIN_ENABLED and ships hidden until that is done.
 */

export type AppleSignInFailure =
  | 'cancelled'
  | 'unavailable'
  | 'network'
  | 'invalid_token'
  | 'unknown';

export type AppleSignInResult =
  | { ok: true }
  | { ok: false; reason: AppleSignInFailure; message: string };

const APPLE_WEB_ENABLED =
  ((import.meta.env.VITE_APPLE_SIGNIN_ENABLED as string | undefined) ?? '').trim() === 'true';

/**
 * Whether "Continuar com Apple" can be offered here. iOS native: gated by the
 * plugin (which is present only when the Sign in with Apple entitlement is on).
 * Web: gated by VITE_APPLE_SIGNIN_ENABLED so it stays hidden until the Supabase
 * Apple provider is configured. Native Android: never (Apple is not offered).
 */
export function isAppleSignInAvailable(): boolean {
  if (Capacitor.getPlatform() === 'ios') return Capacitor.isPluginAvailable('SocialLogin');
  if (!Capacitor.isNativePlatform()) return APPLE_WEB_ENABLED;
  return false;
}

export async function signInWithApple(): Promise<AppleSignInResult> {
  try {
    const result =
      Capacitor.getPlatform() === 'ios' ? await nativeAppleSignIn() : await webAppleSignIn();
    if (result.ok) rememberAuthMethod('apple');
    return result;
  } catch (e) {
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }
}

async function webAppleSignIn(): Promise<AppleSignInResult> {
  const redirectTo = `${window.location.origin}/auth/callback`;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo },
  });
  if (error) return fail(error.message);
  // Redirect under way; AuthCallback.tsx finishes it on return.
  return { ok: true };
}

async function nativeAppleSignIn(): Promise<AppleSignInResult> {
  if (!Capacitor.isPluginAvailable('SocialLogin')) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Login com Apple indisponível nesta versão do app.',
    };
  }

  const { SocialLogin } = await import('@capgo/capacitor-social-login');

  // Same nonce binding as Google: Apple embeds the *hashed* nonce in the
  // identity token; Supabase re-hashes the *raw* nonce we pass to
  // signInWithIdToken and compares. Verify on-device (ETAPA 9): if the token is
  // rejected for a nonce mismatch, pass `raw` to both sides or drop the nonce.
  const { raw, hashed } = await makeNonce();

  // iOS uses the app's entitlement, not a Services ID; redirectUrl '' disables
  // the web redirect (see @capgo apple init docs).
  await SocialLogin.initialize({ apple: { redirectUrl: '' } });

  let idToken: string | null;
  try {
    const { result } = await SocialLogin.login({
      provider: 'apple',
      options: { scopes: ['email', 'name'], nonce: hashed },
    });
    idToken = 'idToken' in result ? result.idToken : null;
  } catch (e) {
    if (isUserCancellation(e)) {
      return { ok: false, reason: 'cancelled', message: 'Login cancelado.' };
    }
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }

  if (!idToken) {
    return {
      ok: false,
      reason: 'invalid_token',
      message: 'Não foi possível obter o token da Apple.',
    };
  }

  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: idToken,
    nonce: raw,
  });
  if (error) return fail(error.message);
  return { ok: true };
}

/** Random raw nonce plus its SHA-256 hex digest. */
async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return { raw, hashed };
}

/** Map a Supabase auth error message to a UI failure reason. Exported for tests. */
export function classifySupabaseError(message: string): AppleSignInFailure {
  if (/network|fetch|failed to fetch|timeout|offline/i.test(message)) return 'network';
  if (/nonce|audience|aud|token|jwt|expired|invalid|signature/i.test(message)) return 'invalid_token';
  return 'unknown';
}

function fail(message: string): AppleSignInResult {
  return { ok: false, reason: classifySupabaseError(message), message };
}

function classifyThrown(e: unknown): AppleSignInFailure {
  const msg = describe(e).toLowerCase();
  if (/network|fetch|timeout|offline|connection/.test(msg)) return 'network';
  return 'unknown';
}

/** Apple cancellations (code 1001 / "canceled") should be silent, not errors. */
export function isUserCancellation(e: unknown): boolean {
  const msg = describe(e).toLowerCase();
  return (
    /cancel/.test(msg) ||
    /dismiss/.test(msg) ||
    /1001/.test(msg) || // ASAuthorizationError.canceled
    /aborted/.test(msg)
  );
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
