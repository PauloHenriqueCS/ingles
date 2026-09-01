/**
 * Haptics for the streak-celebration PREVIEW — REUSES the existing
 * `src/celebration/celebrationHaptics.ts` module verbatim (which itself wraps
 * @capacitor/haptics with a `navigator.vibrate` web fallback and swallows every
 * failure). No new package, no second haptics infrastructure.
 *
 * Mapping:
 *   - milestone       → light activity tap (quick, energetic)
 *   - personal_record → richer "success" pattern
 *   - both            → richer "success" pattern
 *
 * On the current remote-first WebView this degrades to `navigator.vibrate`; real
 * device haptics require the native build that has run `npx cap sync` (already
 * true for the shipped celebration).
 */
import {
  triggerActivityHaptic,
  triggerDayCompleteHaptic,
} from '../../celebration/celebrationHaptics';
import type { StreakCelebrationType } from './streakCelebrationTypes';

export function triggerStreakHaptic(type: StreakCelebrationType): void {
  if (type === 'milestone') {
    triggerActivityHaptic();
  } else {
    triggerDayCompleteHaptic();
  }
}
