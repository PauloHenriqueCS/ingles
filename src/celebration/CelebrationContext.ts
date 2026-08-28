import { createContext } from 'react';
import type { Celebration, CelebrationActivityType } from './celebration-types';

export interface CelebrationContextValue {
  /**
   * The primary API. Call this AFTER an activity's completion is genuinely
   * confirmed/persisted (a real not-completed → completed transition). It
   * resolves — from the real plan + today's progress — whether to show the
   * individual 'activity-complete' celebration or, if this finished every
   * obligatory practice of the day, ONLY the bigger 'day-complete' one. Safe to
   * call fire-and-forget; navigation may proceed immediately (the overlay lives
   * above the whole app and outlives screen transitions).
   */
  notifyActivityCompleted: (activity: CelebrationActivityType) => void;

  /** Low-level escape hatches (mainly for tests / explicit triggers). */
  celebrateActivityComplete: (
    payload: Extract<Celebration, { type: 'activity-complete' }>,
  ) => void;
  celebrateDayComplete: (payload: Extract<Celebration, { type: 'day-complete' }>) => void;
}

export const CelebrationContext = createContext<CelebrationContextValue | null>(null);
