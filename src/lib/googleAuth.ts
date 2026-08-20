import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase';
import { rememberAuthMethod } from './authMethodMemory';
import { logAuthDiag } from './authDiag';

/**
 * Google sign-in, brokered by Supabase Auth (the session authority) so a
 * Google user ends up on the *same* auth.users.id (UUID) the rest of the app
 * already keys on — profile-less design, trial trigger, RLS and the RevenueCat
 * App User ID all follow that UUID unchanged. This module is the ONLY place
 * that talks to a Google provider; everything else calls signInWithGoogle().
 *
 * Two runtime paths, one outcome (a Supabase session):
 *  - Native (Capacitor Android): obtain a Google ID token via
 *    @capgo/capacitor-social-login (Android Credential Manager) and hand it to
 *    supabase.auth.signInWithIdToken. No browser, no custom-scheme redirect —
 *    deliberately, because LemonWebViewClient blocks every non-http(s) scheme,
 *    which would drop an OAuth redirect. The plugin is imported dynamically so
 *    it never enters the web bundle's load path (mirrors revenueCatClient.ts).
 *  - Web (browser): supabase.auth.signInWithOAuth redirect, completed by the
 *    existing AuthCallback.tsx PKCE handler at /auth/callback. No client id is
 *    needed in the bundle here — Supabase holds the Google client secret.
 */

export type GoogleSignInFailure =
  | 'cancelled' // user dismissed the Google sheet / popup — show nothing
  | 'unavailable' // native plugin or web client id missing — Google not offered here
  | 'network' // could not reach Google or Supabase
  | 'invalid_token' // Supabase rejected the Google ID token (aud/nonce/exp)
  | 'unknown';

export type GoogleSignInResult =
  | { ok: true }
  | { ok: false; reason: GoogleSignInFailure; message: string };

/** The Google *Web* OAuth client id (a public value, not a secret) used as the
 *  serverClientId/audience of the native ID-token flow. Read only on native;
 *  the web redirect path does not need it. See .env.example. */
const WEB_CLIENT_ID =
  ((import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined) ?? '').trim();

/** The Google *iOS* OAuth client id (public, not a secret). REQUIRED on iOS:
 *  @capgo's SocialLoginPlugin.swift only initializes the Google provider when an
 *  `iOSClientId` is supplied (it guards `if let clientId = iOSClientId`), so
 *  without this the native iOS Google flow never starts. Unused on Android/web,
 *  which key off the Web client id. Must be set as VITE_GOOGLE_IOS_CLIENT_ID in
 *  Vercel PROD (remote-first: the value is baked into the deployed web bundle). */
const IOS_CLIENT_ID =
  ((import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID as string | undefined) ?? '').trim();

/**
 * Build the provider-specific `google` block for SocialLogin.initialize. Pure and
 * exported so the platform branching is unit-testable without a device.
 *  - Android (and any other native): EXACTLY `{ webClientId }` — the validated,
 *    unchanged Credential-Manager configuration. Do not add fields here.
 *  - iOS: GoogleSignIn needs the iOS client id, and to mint an ID token whose
 *    `aud` Supabase accepts it needs `iOSServerClientId` = the Web client id
 *    (Supabase's Google provider "Authorized Client IDs"). `online` returns the
 *    ID token (offline would return only a serverAuthCode).
 */
export function buildGoogleInitOptions(
  platform: string,
  webClientId: string,
  iosClientId: string,
): Record<string, unknown> {
  if (platform === 'ios') {
    return {
      webClientId,
      iOSClientId: iosClientId,
      iOSServerClientId: webClientId,
      mode: 'online',
    };
  }
  return { webClientId };
}

/**
 * Whether the current runtime can even offer "Continuar com Google", so the UI
 * can hide the button instead of showing one that always fails. Fails closed on
 * native (needs both the plugin and the web client id; iOS additionally needs
 * the iOS client id); web is always offerable (Supabase gates whether the
 * provider is actually enabled).
 */
export function isGoogleSignInAvailable(): boolean {
  if (Capacitor.isNativePlatform()) {
    if (WEB_CLIENT_ID === '' || !Capacitor.isPluginAvailable('SocialLogin')) return false;
    // iOS needs the iOS OAuth client id too, or the native flow can't start.
    if (Capacitor.getPlatform() === 'ios') return IOS_CLIENT_ID !== '';
    return true;
  }
  return true;
}

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  try {
    const result = Capacitor.isNativePlatform()
      ? await nativeGoogleSignIn()
      : await webGoogleSignIn();
    if (result.ok) rememberAuthMethod('google');
    return result;
  } catch (e) {
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }
}

async function webGoogleSignIn(): Promise<GoogleSignInResult> {
  const redirectTo = `${window.location.origin}/auth/callback`;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) return fail(error.message);
  // signInWithOAuth resolves right before it navigates the page to Google;
  // AuthCallback.tsx finishes the PKCE exchange on return. A no-error return
  // means the redirect is under way — treat it as success-in-progress.
  return { ok: true };
}

async function nativeGoogleSignIn(): Promise<GoogleSignInResult> {
  const platform = Capacitor.getPlatform();
  if (
    WEB_CLIENT_ID === '' ||
    !Capacitor.isPluginAvailable('SocialLogin') ||
    (platform === 'ios' && IOS_CLIENT_ID === '')
  ) {
    logAuthDiag({ provider: 'google', step: 'guard', platform, outcome: 'unavailable' });
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Login com Google indisponível nesta versão do app.',
    };
  }

  const { SocialLogin } = await import('@capgo/capacitor-social-login');

  // Nonce binding (replay protection): Google embeds the *hashed* nonce in the
  // ID token's `nonce` claim; Supabase re-hashes the *raw* nonce we pass to
  // signInWithIdToken and compares. So the plugin gets the hash, Supabase gets
  // the raw value. NOTE: this is the single most likely on-device failure point
  // — if the first device test rejects the token with a nonce mismatch, the fix
  // is either to pass `raw` to both sides or to drop the nonce entirely (and
  // rely on aud verification). Verify on a real device (ETAPA 9).
  const { raw, hashed } = await makeNonce();

  await ensureInitialized(SocialLogin);

  let idToken: string | null;
  try {
    // NO `scopes` here on purpose. We only need the OIDC identity token for
    // supabase.auth.signInWithIdToken — Credential Manager's GetGoogleIdOption
    // already returns an ID token carrying email/profile claims. Passing
    // `scopes` switches @capgo to the Google Authorization (access-token) flow,
    // which requires native MainActivity wiring and otherwise rejects with
    // "You CANNOT use scopes without modifying the main activity" (the exact
    // error the debug APK hit). Identity-only, so no scopes, no access token.
    const { result } = await SocialLogin.login({
      provider: 'google',
      options: { nonce: hashed },
    });
    idToken = 'idToken' in result ? result.idToken : null;
  } catch (e) {
    if (isUserCancellation(e)) {
      logAuthDiag({ provider: 'google', step: 'login', platform, outcome: 'cancelled' });
      return { ok: false, reason: 'cancelled', message: 'Login cancelado.' };
    }
    logAuthDiag({ provider: 'google', step: 'login', platform, outcome: classifyThrown(e) });
    return { ok: false, reason: classifyThrown(e), message: describe(e) };
  }

  logAuthDiag({ provider: 'google', step: 'login', platform, idTokenPresent: !!idToken });
  if (!idToken) {
    return {
      ok: false,
      reason: 'invalid_token',
      message: 'Não foi possível obter o token do Google.',
    };
  }

  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
    nonce: raw,
  });
  if (error) {
    logAuthDiag({ provider: 'google', step: 'supabase', platform, supabaseError: error.message });
    return fail(error.message);
  }
  // On success useAuth's onAuthStateChange picks up the session and App.tsx
  // renders the main view; RevenueCat re-identifies via useRevenueCatIdentitySync.
  return { ok: true };
}

let initialized = false;
async function ensureInitialized(
  SocialLogin: typeof import('@capgo/capacitor-social-login').SocialLogin,
): Promise<void> {
  if (initialized) return;
  const platform = Capacitor.getPlatform();
  try {
    await SocialLogin.initialize({
      google: buildGoogleInitOptions(platform, WEB_CLIENT_ID, IOS_CLIENT_ID),
    });
    initialized = true;
    logAuthDiag({ provider: 'google', step: 'initialize', platform, initOk: true });
  } catch (e) {
    logAuthDiag({ provider: 'google', step: 'initialize', platform, initOk: false });
    throw e;
  }
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
export function classifySupabaseError(message: string): GoogleSignInFailure {
  if (/network|fetch|failed to fetch|timeout|offline/i.test(message)) return 'network';
  if (/nonce|audience|aud|token|jwt|expired|invalid|signature/i.test(message)) return 'invalid_token';
  return 'unknown';
}

function fail(message: string): GoogleSignInResult {
  return { ok: false, reason: classifySupabaseError(message), message };
}

function classifyThrown(e: unknown): GoogleSignInFailure {
  const msg = describe(e).toLowerCase();
  if (/network|fetch|timeout|offline|connection/.test(msg)) return 'network';
  return 'unknown';
}

/** Google/Credential-Manager cancellations surface many ways across devices;
 *  treat any of these as a silent user cancel rather than an error. */
export function isUserCancellation(e: unknown): boolean {
  const msg = describe(e).toLowerCase();
  return (
    /cancel/.test(msg) || // "canceled", "cancelled", "user canceled"
    /dismiss/.test(msg) ||
    /no credential/.test(msg) || // Credential Manager: user closed the sheet
    /12501/.test(msg) || // legacy Google Sign-In SIGN_IN_CANCELLED
    /activity.*result.*canceled/.test(msg)
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
