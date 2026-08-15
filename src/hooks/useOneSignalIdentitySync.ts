import { useEffect } from 'react';
import {
  initializeOneSignal,
  syncOneSignalIdentity,
  isOneSignalSupported,
} from '../lib/push/onesignalClient';

/**
 * Bridges the Supabase session to OneSignal, mirroring
 * useRevenueCatIdentitySync. Two deliberately separate concerns (ETAPA 4/5):
 *
 *   1. Bootstrap — initialize the SDK exactly once when the native app starts,
 *      independent of whether anyone is signed in yet. This registers the
 *      device subscription. It does NOT prompt for permission.
 *   2. Identity — keep the OneSignal external_id in lockstep with the session:
 *      login with the real Supabase UUID as soon as it's known, logout when the
 *      session ends, re-login on account switch.
 *
 * Safe to mount unconditionally (App.tsx, once): every call is a no-op on web
 * and both entry points are idempotent, so this never touches the SDK outside
 * a native iOS/Android build and never double-initializes under StrictMode.
 */
export function useOneSignalIdentitySync(userId: string | null | undefined): void {
  // (1) Bootstrap: run once, native-only.
  useEffect(() => {
    if (!isOneSignalSupported()) return;
    void initializeOneSignal();
  }, []);

  // (2) Identity: re-run whenever the authoritative user id changes.
  useEffect(() => {
    if (!isOneSignalSupported()) return;
    void syncOneSignalIdentity(userId ?? null);
  }, [userId]);
}
