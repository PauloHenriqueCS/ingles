/**
 * Celebration haptics — a light tap for an activity, a slightly richer pattern
 * for a completed day.
 *
 * Strategy:
 *   - Native (Capacitor): dynamically import @capacitor/haptics and use the
 *     Haptics plugin. The dynamic import + isPluginAvailable guard means that on
 *     a native build that has NOT yet bundled the plugin (i.e. before the next
 *     `npx cap sync` + rebuild), this degrades to a silent no-op instead of
 *     throwing "plugin not implemented".
 *   - Web (incl. the current remote-first WebView): fall back to the Vibration
 *     API (navigator.vibrate) where the platform allows it; otherwise no-op.
 *
 * Everything is best-effort and fully swallowed: a haptics failure must NEVER
 * break the activity completion. On web without Vibration support it degrades
 * silently, exactly as required.
 *
 * ⚠️ Device haptics on the installed native app require a NEW native build
 * (npm i @capacitor/haptics is done; `npx cap sync` + rebuild wires the native
 * side). Until then, native calls no-op and web uses navigator.vibrate.
 *
 * A module-level mute flag is exposed for a future settings toggle.
 */
import { isNativeApp, isPluginAvailable } from '../lib/runtimeEnvironment';

let muted = false;

export function setCelebrationHapticsMuted(value: boolean): void {
  muted = value;
}

export function isCelebrationHapticsMuted(): boolean {
  return muted;
}

function webVibrate(pattern: number | number[]): void {
  try {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
        : undefined;
    if (nav && typeof nav.vibrate === 'function') nav.vibrate(pattern);
  } catch {
    /* silent */
  }
}

async function nativeImpact(style: 'Light' | 'Medium'): Promise<boolean> {
  try {
    if (!isNativeApp || !isPluginAvailable('Haptics')) return false;
    const mod = await import('@capacitor/haptics');
    await mod.Haptics.impact({ style: mod.ImpactStyle[style] });
    return true;
  } catch {
    return false;
  }
}

async function nativeNotificationSuccess(): Promise<boolean> {
  try {
    if (!isNativeApp || !isPluginAvailable('Haptics')) return false;
    const mod = await import('@capacitor/haptics');
    await mod.Haptics.notification({ type: mod.NotificationType.Success });
    return true;
  } catch {
    return false;
  }
}

/** Light tap for a single activity completion. */
export function triggerActivityHaptic(): void {
  if (muted) return;
  void (async () => {
    const handledNatively = await nativeImpact('Light');
    if (!handledNatively) webVibrate(18);
  })();
}

/** Slightly more perceptible, still elegant — for a completed day. */
export function triggerDayCompleteHaptic(): void {
  if (muted) return;
  void (async () => {
    const handledNatively = await nativeNotificationSuccess();
    // Web fallback: a short double-pulse, never a long buzz.
    if (!handledNatively) webVibrate([0, 35, 55, 45]);
  })();
}
