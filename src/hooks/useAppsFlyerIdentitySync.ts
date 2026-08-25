import { useEffect } from 'react';
import {
  initializeAppsFlyer,
  setAppsFlyerCustomerUserId,
  isAppsFlyerSupported,
} from '../lib/analytics/appsFlyerClient';

/**
 * Bridges the Supabase session to AppsFlyer, mirroring
 * useOneSignalIdentitySync. Two deliberately separate concerns:
 *
 *   1. Bootstrap — initialize (and auto-start) the SDK exactly once when the
 *      native app starts, INDEPENDENT of whether anyone is signed in yet. This
 *      is what attributes the install/open.
 *   2. Identity — keep the AppsFlyer Customer User ID in lockstep with the
 *      session: set the real Supabase UUID as soon as it's known (session
 *      restore or login), and update it on an account switch. Sign-out is a
 *      no-op (AppsFlyer has no clear-CUID API — see appsFlyerClient.ts).
 *
 * Safe to mount unconditionally (App.tsx, once): every call is a no-op on web
 * and both entry points are idempotent, so this never touches the SDK outside a
 * native iOS/Android build and never double-initializes under StrictMode.
 */
export function useAppsFlyerIdentitySync(userId: string | null | undefined): void {
  // (1) Bootstrap: run once, native-only.
  useEffect(() => {
    if (!isAppsFlyerSupported()) return;
    void initializeAppsFlyer();
  }, []);

  // (2) Identity: re-run whenever the authoritative user id changes.
  useEffect(() => {
    if (!isAppsFlyerSupported()) return;
    void setAppsFlyerCustomerUserId(userId ?? null);
  }, [userId]);
}
