/**
 * Shared types for the STREAK-CELEBRATION PREVIEW LAB (dev-only).
 *
 * ⚠️ This whole `src/dev/streak-celebration/` folder is an ISOLATED design lab.
 * It does NOT touch the real celebration flow (`src/celebration/`), the database,
 * streak detection, or any product screen. It only reuses the existing shared
 * infrastructure (framer-motion, lottie-react, the HTMLAudio sound module and the
 * Capacitor haptics module) so the final, approved experience can be lifted into
 * the real system with matching tech.
 */

/** The three situations the final reusable streak celebration must cover. */
export type StreakCelebrationType =
  /** A fixed streak milestone (7, 14, 30, 60, 100, 365, …). */
  | 'milestone'
  /** The user beat their own previous best streak. */
  | 'personal_record'
  /** Same moment hits a fixed milestone AND a new personal best. */
  | 'both';

/** The visually distinct proposals to compare (confetti = chosen direction). */
export type StreakVisualVariant =
  /** A. Flame / energy — emerald streak ring + flame + sparks. */
  | 'flame'
  /** B. Trophy / record — reuses the existing Trophy Lottie, premium/gold. */
  | 'trophy'
  /** C. Orodim premium — brand aurora gradient, elegant halo, growth. */
  | 'orodim'
  /** H. Confetti — tasteful falling-ribbon burst around the day count (CHOSEN). */
  | 'confetti';

/** The sound proposals (seal = chosen direction). */
export type StreakSoundOption =
  /** Short & discreet (reuses activity-complete.mp3). */
  | 'discreet'
  /** Stronger achievement (reuses day-complete.mp3). */
  | 'achievement'
  /** Premium / elegant (isolated dev asset premium-chime.mp3). */
  | 'premium'
  /** Digital "seal" chime — Mixkit id 2018 (isolated dev asset seal.mp3, CHOSEN). */
  | 'seal'
  /** No sound. */
  | 'none';

/**
 * Everything the overlay needs to render. Fully explicit — the lab owns all of
 * this state, nothing is fetched or read from context/DB.
 */
export interface StreakCelebrationConfig {
  type: StreakCelebrationType;
  variant: StreakVisualVariant;
  sound: StreakSoundOption;
  /** The streak length in days to display (7, 14, 30, 60, 100, 365, …). */
  days: number;
  /**
   * The previous best, used only in `personal_record` / `both` copy. When
   * omitted we fall back to a sensible value derived from `days`.
   */
  previousBest?: number;
}

export const STREAK_TYPES: readonly StreakCelebrationType[] = [
  'milestone',
  'personal_record',
  'both',
] as const;

export const STREAK_VARIANTS: readonly StreakVisualVariant[] = [
  'confetti',
  'flame',
  'trophy',
  'orodim',
] as const;

export const STREAK_SOUND_OPTIONS: readonly StreakSoundOption[] = [
  'seal',
  'discreet',
  'achievement',
  'premium',
  'none',
] as const;

/** The fixed milestones the product intends to celebrate. */
export const MILESTONE_PRESETS: readonly number[] = [7, 14, 30, 60, 100, 365] as const;
