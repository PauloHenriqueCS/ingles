import { useEffect, useRef } from 'react';
import { isOneSignalSupported, maybeRequestPushPermission } from '../lib/push/onesignalClient';

/**
 * Asks for notification permission at the first authenticated use of the app,
 * once Home is actually on screen (ETAPA 5). Mounted once in App.tsx; pass
 * `readyAtHome = true` only after every bootstrap/login/onboarding gate has
 * cleared, so the OS prompt never appears on the login screen, a splash, or
 * mid-authentication.
 *
 * All the real safety (support check, "already asked", granted/denied handling,
 * single-flight under StrictMode) lives in maybeRequestPushPermission(); this
 * hook only decides WHEN to call it. The local ref is a cheap guard against
 * re-firing on unrelated rerenders — the module-level guard is the source of
 * truth across StrictMode remounts (which reset this ref).
 */
export function usePushPermissionPrompt(readyAtHome: boolean): void {
  const askedRef = useRef(false);

  useEffect(() => {
    if (!readyAtHome) return;
    if (askedRef.current) return;
    if (!isOneSignalSupported()) return; // web / non-native → never touch the SDK
    askedRef.current = true;
    void maybeRequestPushPermission();
  }, [readyAtHome]);
}
