import { describe, it, expect } from 'vitest';
import { CELEBRATION_TIMING } from '../celebrationTiming';

// The exit-animation durations declared on the overlay's root motion element.
const EXIT_MS = { 'activity-complete': 260, 'day-complete': 340 };

describe('celebration choreography timings', () => {
  it('activity total is ~1.5–1.8s (hold + exit) — not instant', () => {
    const total = CELEBRATION_TIMING['activity-complete'].holdMs + EXIT_MS['activity-complete'];
    expect(total).toBeGreaterThanOrEqual(1500);
    expect(total).toBeLessThanOrEqual(1800);
  });

  it('day-complete total is ~2.2–2.8s (hold + exit) — a bigger moment', () => {
    const total = CELEBRATION_TIMING['day-complete'].holdMs + EXIT_MS['day-complete'];
    expect(total).toBeGreaterThanOrEqual(2200);
    expect(total).toBeLessThanOrEqual(2800);
  });

  it('activity sequence is ordered: impact → title → sub → exit', () => {
    const a = CELEBRATION_TIMING['activity-complete'];
    expect(a.impactMs).toBeGreaterThanOrEqual(300);
    expect(a.impactMs).toBeLessThanOrEqual(400); // impact/sound/haptic beat
    expect(a.titleDelay * 1000).toBeGreaterThan(a.impactMs);
    expect(a.subDelay).toBeGreaterThan(a.titleDelay);
    expect(a.subDelay * 1000).toBeLessThan(a.holdMs);
  });

  it('day sequence is ordered: impact → title → sub → streak → exit', () => {
    const d = CELEBRATION_TIMING['day-complete'];
    expect(d.impactMs).toBeGreaterThanOrEqual(400);
    expect(d.impactMs).toBeLessThanOrEqual(500);
    expect(d.titleDelay * 1000).toBeGreaterThan(d.impactMs);
    expect(d.subDelay).toBeGreaterThan(d.titleDelay);
    expect(d.streakDelay).toBeDefined();
    expect(d.streakDelay!).toBeGreaterThan(d.subDelay);
    expect(d.streakDelay! * 1000).toBeLessThan(d.holdMs);
  });

  it('day is perceptibly longer than activity', () => {
    expect(CELEBRATION_TIMING['day-complete'].holdMs).toBeGreaterThan(
      CELEBRATION_TIMING['activity-complete'].holdMs,
    );
  });
});
