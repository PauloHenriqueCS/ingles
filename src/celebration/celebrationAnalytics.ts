/**
 * Minimal, fail-safe observability for celebrations. This is NOT a new analytics
 * architecture — there is no generic product-event sink in the app; the only
 * event pipeline is AppsFlyer (native-only marketing). So we:
 *
 *   1. forward a PII-free `celebration_shown` event to AppsFlyer's low-level,
 *      fail-safe logger (a no-op on web / when unsupported), and
 *   2. emit a `console.debug` + a `window` CustomEvent so the same signal is
 *      observable on web/homolog and trivial to hook a real product-analytics
 *      sink onto later — without changing any call site.
 *
 * No user-authored text, email, or name is ever included — only the celebration
 * type, activity type, and the day's completed/total counts.
 */
import { logAppsFlyerEvent } from '../lib/analytics/appsFlyerClient';
import type { Celebration } from './celebration-types';

export interface CelebrationShownPayload {
  type: 'activity_complete' | 'day_complete';
  activity_type?: string;
  completed_count?: number;
  total_count?: number;
}

export function trackCelebrationShown(celebration: Celebration): void {
  try {
    const payload: CelebrationShownPayload =
      celebration.type === 'activity-complete'
        ? {
            type: 'activity_complete',
            activity_type: celebration.activityType,
            completed_count: celebration.completedCount,
            total_count: celebration.totalCount,
          }
        : {
            type: 'day_complete',
            completed_count: celebration.completedCount,
            total_count: celebration.totalCount,
          };

    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[celebration] shown', payload);
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('celebration:shown', { detail: payload }));
    }
    // Native-only, fail-safe (resolves false on web). Fire-and-forget.
    void logAppsFlyerEvent('celebration_shown', { ...payload });
  } catch {
    /* observability must never break the celebration */
  }
}
