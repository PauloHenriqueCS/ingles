/**
 * Central place for celebration user-preferences, organized so a future settings
 * screen can flip them without touching any call site:
 *
 *   - reduced motion  → honored from the OS `prefers-reduced-motion` today; a
 *     manual override can be added here later.
 *   - completion sounds on/off → setCelebrationSoundMuted (re-exported).
 *   - haptics on/off          → setCelebrationHapticsMuted (re-exported).
 *
 * No new settings UI is introduced now (per scope), but everything routes through
 * this module so adding one is a one-file change.
 */
export {
  setCelebrationSoundMuted,
  isCelebrationSoundMuted,
} from './celebrationSound';
export {
  setCelebrationHapticsMuted,
  isCelebrationHapticsMuted,
} from './celebrationHaptics';

/** True when the OS asks for reduced motion. Safe on SSR/test (defaults false). */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}
