/**
 * Haptics for the streak celebration — a LONGER, celebratory pattern (per the
 * chosen direction). Reuses the project's existing @capacitor/haptics plugin and
 * the `navigator.vibrate` web fallback (the exact same infrastructure the shipped
 * `src/celebration/celebrationHaptics.ts` uses), only choreographed longer. No new
 * package, no second haptics system. Every call is best-effort and swallowed.
 *
 * Native: a short build-up of impacts ending on a "success" notification.
 * Web: a longer multi-pulse vibration pattern (ms on/off list).
 * record / both get a slightly longer + stronger version than a plain milestone.
 *
 * On the current remote-first WebView this degrades to `navigator.vibrate`; real
 * device haptics require the native build that has run `npx cap sync`.
 */
import { isNativeApp, isPluginAvailable } from '../../lib/runtimeEnvironment';
import type { StreakCelebrationType } from './streakCelebrationTypes';

function webVibrate(pattern: number[]): void {
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nativeSequence(strong: boolean): Promise<boolean> {
  try {
    if (!isNativeApp || !isPluginAvailable('Haptics')) return false;
    const mod = await import('@capacitor/haptics');
    await mod.Haptics.impact({ style: mod.ImpactStyle.Medium });
    await wait(90);
    await mod.Haptics.impact({ style: strong ? mod.ImpactStyle.Heavy : mod.ImpactStyle.Medium });
    await wait(90);
    if (strong) {
      await mod.Haptics.impact({ style: mod.ImpactStyle.Heavy });
      await wait(90);
    }
    await mod.Haptics.notification({ type: mod.NotificationType.Success });
    return true;
  } catch {
    return false;
  }
}

/** Longer celebratory haptic for the streak celebration. */
export function triggerStreakHaptic(type: StreakCelebrationType): void {
  const strong = type !== 'milestone';
  const web = strong
    ? [0, 55, 60, 55, 60, 55, 60, 55, 60, 190]
    : [0, 45, 60, 45, 60, 45, 60, 150];
  void (async () => {
    const handledNatively = await nativeSequence(strong);
    if (!handledNatively) webVibrate(web);
  })();
}
