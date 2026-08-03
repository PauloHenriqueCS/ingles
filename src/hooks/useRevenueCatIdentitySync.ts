import { useEffect } from 'react';
import { syncIdentity, isRevenueCatSupported } from '../lib/revenueCat/revenueCatClient';

/**
 * Keeps the RevenueCat App User ID in lockstep with the Supabase session —
 * logs in with the real UUID as soon as it's known, logs out when the
 * session ends. Safe to mount unconditionally (App.tsx, once): every call
 * is a no-op on web/Android (see revenueCatClient.ts's isRevenueCatSupported
 * guard), so this never touches the SDK outside native iOS.
 */
export function useRevenueCatIdentitySync(userId: string | null | undefined): void {
  useEffect(() => {
    if (!isRevenueCatSupported()) return;
    syncIdentity(userId ?? null);
  }, [userId]);
}
