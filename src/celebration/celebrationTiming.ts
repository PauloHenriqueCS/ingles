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
}

export const CELEBRATION_TIMING: {
  'activity-complete': CelebrationTiming;
  'day-complete': CelebrationTiming;
} = {
  // 0 enter · 150 spring · ~350 impact(sound+haptic) · 550 title · 800 sub · 1400 exit · ~1700 gone
  'activity-complete': {
    holdMs: 1400,
    impactMs: 350,
    contentDelayMs: 150,
    titleDelay: 0.55,
    subDelay: 0.8,
  },
  // 0 enter · 200 grow · ~450 impact(sound+haptic) · 600 title · 900 sub · 1300 streak · 2300 exit · ~2700 gone
  'day-complete': {
    holdMs: 2300,
    impactMs: 450,
    contentDelayMs: 200,
    titleDelay: 0.6,
    subDelay: 0.9,
    streakDelay: 1.3,
  },
};
