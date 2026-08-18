import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase';
import { ANDROID_OAUTH_CALLBACK } from './appleAuth';

/**
 * Completes a native OAuth flow that returned to the app via a custom-scheme
 * deep link (Android Apple sign-in — see androidAppleSignIn in appleAuth.ts).
 * The system browser (Custom Tab) sends `com.orodim.app://auth/callback?...`
 * back through an AndroidManifest intent-filter; @capacitor/app's appUrlOpen
 * delivers it here, and we turn the returned params into a Supabase session.
 *
 * PKCE-ONLY: this handler exclusively completes the PKCE `?code=` flow via
 * exchangeCodeForSession. It deliberately does NOT accept implicit
 * `#access_token&refresh_token` tokens from a deep link — a co-installed app
 * that registered the same custom scheme could otherwise hand us a real
 * session. Implicit-token callbacks are ignored.
 * A provider error / user cancel is silent: no error, no broken session.
 */

export type AuthDeepLinkAction =
  | { kind: 'ignore' }
  | { kind: 'error'; message: string }
  | { kind: 'code'; code: string };

/** Pure parse of a deep-link URL — unit-testable without a device. Only URLs
 *  that start with our own callback prefix are acted on; everything else is
 *  ignored so unrelated deep links pass through untouched. */
export function parseAuthCallbackUrl(url: string, prefix: string = ANDROID_OAUTH_CALLBACK): AuthDeepLinkAction {
  if (!url || !url.startsWith(prefix)) return { kind: 'ignore' };
  const { query, hash } = splitUrl(url);
  const q = new URLSearchParams(query);
  const h = new URLSearchParams(hash);

  const err =
    q.get('error_description') || h.get('error_description') || q.get('error') || h.get('error');
  if (err) return { kind: 'error', message: err };

  const code = q.get('code');
  if (code) return { kind: 'code', code };

  // Implicit `#access_token&refresh_token` callbacks are intentionally NOT
  // accepted (see file header): PKCE-only. Anything without a `?code=` is
  // ignored so a spoofed implicit deep link can never establish a session.
  return { kind: 'ignore' };
}

function splitUrl(url: string): { query: string; hash: string } {
  const hashIdx = url.indexOf('#');
  const hash = hashIdx >= 0 ? url.slice(hashIdx + 1) : '';
  const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = beforeHash.indexOf('?');
  const query = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : '';
  return { query, hash };
}

let installed = false;

/** Registers the appUrlOpen listener once, on native only (no-op on web). */
export function installNativeAuthDeepLinkHandler(): void {
  if (installed || !Capacitor.isNativePlatform()) return;
  installed = true;
  void import('@capacitor/app')
    .then(({ App }) => {
      App.addListener('appUrlOpen', (event: { url: string }) => {
        void handleAuthDeepLink(event.url);
      });
    })
    .catch(() => {});
}

async function handleAuthDeepLink(url: string): Promise<void> {
  const action = parseAuthCallbackUrl(url);
  if (action.kind === 'ignore') return;

  // Dismiss the Custom Tab regardless of outcome.
  void import('@capacitor/browser').then(({ Browser }) => Browser.close().catch(() => {})).catch(() => {});

  if (action.kind === 'error') return; // cancel / provider error → stay on login

  if (action.kind !== 'code') return; // PKCE-only: nothing else establishes a session

  try {
    await supabase.auth.exchangeCodeForSession(action.code);
    // onAuthStateChange → useAuth → App.tsx renders the Home. rememberAuthMethod
    // was already recorded when the browser opened (signInWithApple).
  } catch {
    // Leave the login screen intact — nothing half-applied that breaks state.
  }
}
