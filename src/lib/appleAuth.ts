import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase';
import { rememberAuthMethod } from './authMethodMemory';
import { logAuthDiag } from './authDiag';

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

/** Custom-scheme deep link the Supabase Apple OAuth redirect returns to on
 *  Android (which has no native Apple SDK). It MUST be present in the Supabase
 *  project's Authentication → URL Configuration → Redirect URLs allow list
 *  (homolog AND prod), or Supabase falls back to the Site URL and the return
 *  breaks. Received by the AndroidManifest intent-filter + the appUrlOpen
 *  listener in nativeAuthDeepLink.ts. Same string for debug/prod — the
 *  environment differs only by which Supabase the loaded frontend talks to. */
export const ANDROID_OAUTH_CALLBACK = 'com.orodim.app://auth/callback';

/**
 * Whether "Continuar com Apple" can be offered here.
 *  - iOS: native @capgo path, gated by the Sign in with Apple entitlement/plugin.
 *  - Web AND Android: gated by the same VITE_APPLE_SIGNIN_ENABLED flag. Android
 *    has no native Apple SDK, so it uses the OAuth-in-system-browser flow
 *    (androidAppleSignIn) with a deep-link return — offered whenever the Supabase
 *    Apple provider is enabled.
 */
export function isAppleSignInAvailable(): boolean {
  if (Capacitor.getPlatform() === 'ios') return Capacitor.isPluginAvailable('SocialLogin');
  return APPLE_WEB_ENABLED;
}

export async function signInWithApple(): Promise<AppleSignInResult> {
  try {
    const platform = Capacitor.getPlatform();
    const result =
      platform === 'ios'
        ? await nativeAppleSignIn()
        : platform === 'android'
          ? await androidAppleSignIn()
          : await webAppleSignIn();
    if (result.ok) rememberAuthMethod('apple');
    return result;
  } catch (e) {
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }
}

/**
 * Android has no Apple AuthenticationServices. Run the Supabase Apple OAuth in
 * the system browser (a Chrome Custom Tab via @capacitor/browser) and return to
 * the app through the ANDROID_OAUTH_CALLBACK deep link. `skipBrowserRedirect`
 * stops supabase-js from navigating the WebView — we open `data.url` ourselves.
 * The session is finished by the appUrlOpen handler in nativeAuthDeepLink.ts.
 * This is NOT an embedded-WebView spoof: auth happens in the real system browser.
 */
async function androidAppleSignIn(): Promise<AppleSignInResult> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: ANDROID_OAUTH_CALLBACK, skipBrowserRedirect: true },
  });
  if (error) return fail(error.message);
  if (!data?.url) {
    return { ok: false, reason: 'unknown', message: 'Não foi possível iniciar o login com a Apple.' };
  }

  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: data.url });
  // Success-in-progress: the user is now authenticating in the browser. When
  // Supabase redirects back to the deep link, nativeAuthDeepLink.ts establishes
  // the session and App.tsx renders the Home.
  return { ok: true };
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
  // the web redirect (see @capgo apple init docs). Native Sign in with Apple
  // additionally REQUIRES the com.apple.developer.applesignin entitlement on the
  // Release target (AppRelease.entitlements) — without it ASAuthorization is
  // rejected by the OS and this login fails generically.
  try {
    await SocialLogin.initialize({ apple: { redirectUrl: '' } });
    logAuthDiag({ provider: 'apple', step: 'initialize', platform: 'ios', initOk: true });
  } catch (e) {
    logAuthDiag({ provider: 'apple', step: 'initialize', platform: 'ios', initOk: false });
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }

  let idToken: string | null;
  try {
    // Apple embeds the *hashed* nonce in the identity token; @capgo passes this
    // value straight to ASAuthorizationAppleIDRequest.nonce WITHOUT re-hashing
    // (AppleProvider.swift), so we must send the hash here and the raw value to
    // Supabase below. Confirmed against the installed plugin — do not change.
    const { result } = await SocialLogin.login({
      provider: 'apple',
      options: { scopes: ['email', 'name'], nonce: hashed },
    });
    idToken = 'idToken' in result ? result.idToken : null;
  } catch (e) {
    if (isUserCancellation(e)) {
      logAuthDiag({ provider: 'apple', step: 'login', platform: 'ios', outcome: 'cancelled' });
      return { ok: false, reason: 'cancelled', message: 'Login cancelado.' };
    }
    logAuthDiag({ provider: 'apple', step: 'login', platform: 'ios', outcome: classifyThrown(e) });
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }

  logAuthDiag({ provider: 'apple', step: 'login', platform: 'ios', idTokenPresent: !!idToken });
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
  if (error) {
    logAuthDiag({ provider: 'apple', step: 'supabase', platform: 'ios', supabaseError: error.message });
    return fail(error.message);
  }
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
