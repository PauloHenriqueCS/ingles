/**
 * Safe, production-friendly auth diagnostics. Emits a single structured console
 * line so native (iOS/Android) sign-in flows can be diagnosed from the device
 * console without ever leaking sensitive material.
 *
 * HARD RULE — this must NEVER receive or log: ID tokens, access tokens, refresh
 * tokens, Apple authorization codes, nonces, or any secret. Callers pass only
 * booleans/enums/step labels and (at most) a Supabase error *message* string.
 */
export interface AuthDiagFields {
  provider: 'google' | 'apple';
  step: string;
  platform: string;
  /** Whether SocialLogin.initialize resolved without throwing. */
  initOk?: boolean;
  /** Whether the provider returned a non-empty ID token — the token itself is never logged. */
  idTokenPresent?: boolean;
  /** Supabase auth error *message* only (never a token). */
  supabaseError?: string;
  /** Final outcome of the attempt. */
  outcome?: 'ok' | 'cancelled' | 'unavailable' | 'network' | 'invalid_token' | 'unknown';
}

export function logAuthDiag(fields: AuthDiagFields): void {
  try {
    // console.info shows up in Xcode's device console and Android logcat via the
    // WebView bridge. Single-line JSON keeps it greppable.
    // eslint-disable-next-line no-console
    console.info('[auth]', JSON.stringify(fields));
  } catch {
    /* diagnostics must never throw into the auth flow */
  }
}
