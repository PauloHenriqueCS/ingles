/**
 * Choreography timings for the celebration overlay. Deliberately slower than a
 * flash — the experience must read as a sequence of events, not be instant.
 *
 * Total on-screen ≈ holdMs + exit animation:
 *   - activity-complete: ~1.5–1.8s total  (hold 1400ms + ~300ms exit)
 *   - day-complete:      ~2.2–2.8s total  (hold 2300ms + ~400ms exit)
 *
 * `impactMs` = when the Lottie reaches its impact beat → sound + haptic fire.
 * `*Delay` (seconds) = Framer Motion stagger delays for the text lines.
 */
export interface CelebrationTiming {
  /** ms before onExpire() is called (exit begins). */
  holdMs: number;
  /** ms until the sound + haptic impact beat. */
  impactMs: number;
  /** ms delay before the content container springs in. */
  contentDelayMs: number;
  /** seconds — title appears. */
  titleDelay: number;
  /** seconds — progress/subtitle appears. */
  subDelay: number;
  /** seconds — streak line appears (day-complete only). */
  streakDelay?: number;
  /**
   * Playback speed for the Lottie hero, so the animation's meaningful reveal
   * fits inside the on-screen hold. The chosen "payment success" clip is ~4s at
   * 1× — sped up it completes its check within the ~1.5s activity window; the
   * Trophy clip is ~2.37s and plays at 1× within the ~2.3s day window.
   */
  lottieSpeed: number;
}

export const CELEBRATION_TIMING: {
  'activity-complete': CelebrationTiming;
  'day-complete': CelebrationTiming;
  streak: CelebrationTiming;
} = {
  // 0 enter · 150 spring · ~250 impact(sound+haptic, leads the check) · 600 title · 850 sub · 1500 exit · ~1760 gone
  'activity-complete': {
    holdMs: 1500,
    impactMs: 250,
    contentDelayMs: 150,
    titleDelay: 0.6,
    subDelay: 0.85,
    lottieSpeed: 1.0,
  },
  // 0 enter · 200 grow · ~450 impact(sound+haptic) · 600 title · 900 sub · 1300 streak · 2300 exit · ~2700 gone
  'day-complete': {
    holdMs: 2300,
    impactMs: 450,
    contentDelayMs: 200,
    titleDelay: 0.6,
    subDelay: 0.9,
    streakDelay: 1.3,
    lottieSpeed: 1.0,
  },
  // Confetti streak celebration: the sound/haptic land as the number pops in;
  // held a touch longer so the confetti burst + copy read comfortably.
  streak: {
    holdMs: 2800,
    impactMs: 260,
    contentDelayMs: 120,
    titleDelay: 0.6,
    subDelay: 0.82,
    streakDelay: 1.0,
    lottieSpeed: 1.0,
  },
};
