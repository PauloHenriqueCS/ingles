/**
 * Remembers which sign-in method the user last used, so the login screen can
 * later surface a "último método utilizado" hint (e.g. a badge on the Google
 * button) without guessing. Purely a UI convenience — never an auth decision,
 * never trusted for anything security-relevant. Kept deliberately tiny and
 * provider-open ('apple' is already a valid value) so Sign in with Apple can
 * reuse it without a schema change.
 */

export type AuthMethod = 'password' | 'google' | 'apple';

const KEY = 'orodim.lastAuthMethod';

export function rememberAuthMethod(method: AuthMethod): void {
  try {
    localStorage.setItem(KEY, method);
  } catch {
    // Storage unavailable (private mode / disabled) — the hint is optional.
  }
}

export function getLastAuthMethod(): AuthMethod | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'password' || value === 'google' || value === 'apple' ? value : null;
  } catch {
    return null;
  }
}
