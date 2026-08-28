/**
 * Global activity-completion celebration system.
 *
 * Usage:
 *   1. <CelebrationProvider> wraps the app (already mounted in main.tsx).
 *   2. In a completion flow, AFTER the completion is server-confirmed/persisted:
 *          const { notifyActivityCompleted } = useCelebration();
 *          notifyActivityCompleted('listening');
 *      It resolves — from the real plan + today's progress — whether to show the
 *      individual celebration or the bigger day-complete one, and never both.
 */
export { CelebrationProvider } from './CelebrationProvider';
export { useCelebration } from './useCelebration';
export type { CelebrationContextValue } from './CelebrationContext';
export type {
  Celebration,
  CelebrationActivityType,
  ObligatoryActivityType,
} from './celebration-types';
export {
  setCelebrationSoundMuted,
  setCelebrationHapticsMuted,
  prefersReducedMotion,
} from './celebrationPrefs';
