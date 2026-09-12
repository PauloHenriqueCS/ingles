import { useEffect } from 'react';
import { recordDeviceProfile } from '../lib/analytics/deviceProfile';

/**
 * Records the runtime platform + app version for the signed-in user, on every
 * platform (web included) and INDEPENDENT of AppsFlyer. Re-runs whenever the
 * authoritative user id changes (session restore, login, account switch); a
 * sign-out (null) is a no-op. Idempotent server-side (one row/user; last_seen
 * updates, first_seen write-once). Fail-safe. Safe to mount unconditionally.
 */
export function useDeviceProfileSync(userId: string | null | undefined): void {
  useEffect(() => {
    if (!userId) return;
    void recordDeviceProfile(userId);
  }, [userId]);
}
