import { useContext } from 'react';
import { CelebrationContext, type CelebrationContextValue } from './CelebrationContext';

/**
 * Access the global celebration API. Must be used under <CelebrationProvider>.
 * If the provider is somehow absent (e.g. a screen rendered outside the app
 * shell), it returns inert no-ops so a missing provider can never crash a
 * completion flow.
 */
const NOOP: CelebrationContextValue = {
  notifyActivityCompleted: () => {},
  celebrateActivityComplete: () => {},
  celebrateDayComplete: () => {},
};

export function useCelebration(): CelebrationContextValue {
  return useContext(CelebrationContext) ?? NOOP;
}
