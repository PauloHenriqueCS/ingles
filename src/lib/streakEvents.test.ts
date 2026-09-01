import { describe, it, expect } from 'vitest';
import { detectStreakEvent, STREAK_MILESTONES } from './streakEvents';

const ALL7 = [0, 1, 2, 3, 4, 5, 6];

/** ISO date `offset` days from `base` (noon-anchored, UTC-rollover-safe). */
function iso(base: string, offset: number): string {
  const d = new Date(base + 'T12:00:00');
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
/** `count` consecutive daily dates ending at `end` (inclusive). */
function runEndingAt(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => iso(end, -i));
}

describe('detectStreakEvent — milestones', () => {
  const today = '2026-09-30';

  it('fires a milestone the day the streak equals a milestone value', () => {
    const e = detectStreakEvent(runEndingAt(today, 7), ALL7, today);
    expect(e.current).toBe(7);
    expect(e.isMilestone).toBe(true);
    expect(e.isRecord).toBe(false); // previousBest 0 → below threshold
    expect(e.kind).toBe('milestone');
  });

  it('does not fire on a non-milestone streak with no record', () => {
    const e = detectStreakEvent(runEndingAt(today, 5), ALL7, today);
    expect(e.current).toBe(5);
    expect(e.kind).toBeNull();
  });

  it('every configured milestone value triggers', () => {
    for (const m of STREAK_MILESTONES) {
      const e = detectStreakEvent(runEndingAt(today, m), ALL7, today);
      expect(e.isMilestone).toBe(true);
    }
  });
});

describe('detectStreakEvent — personal record', () => {
  const today = '2026-09-30';

  it('fires the day the streak first passes a meaningful previous best', () => {
    // ended run of 5 long ago + current run of 6 → 6 === 5 + 1
    const dates = [...runEndingAt(today, 6), ...runEndingAt(iso(today, -20), 5)];
    const e = detectStreakEvent(dates, ALL7, today);
    expect(e.current).toBe(6);
    expect(e.previousBest).toBe(5);
    expect(e.isRecord).toBe(true);
    expect(e.kind).toBe('personal_record');
  });

  it('does NOT re-fire on later days of the same record run (idempotent)', () => {
    // ended run of 5 + current run of 8 → 8 !== 5 + 1
    const dates = [...runEndingAt(today, 8), ...runEndingAt(iso(today, -20), 5)];
    const e = detectStreakEvent(dates, ALL7, today);
    expect(e.current).toBe(8);
    expect(e.previousBest).toBe(5);
    expect(e.isRecord).toBe(false);
    expect(e.kind).toBeNull();
  });

  it('suppresses record below the meaningful-best threshold', () => {
    // ended run of 1 + current run of 2 → previousBest 1 < 3
    const dates = [...runEndingAt(today, 2), ...runEndingAt(iso(today, -20), 1)];
    const e = detectStreakEvent(dates, ALL7, today);
    expect(e.isRecord).toBe(false);
    expect(e.kind).toBeNull();
  });
});

describe('detectStreakEvent — both', () => {
  it('milestone + record on the same day → both', () => {
    const today = '2026-09-30';
    // ended run of 6 + current run of 7 → 7 is a milestone AND 7 === 6 + 1
    const dates = [...runEndingAt(today, 7), ...runEndingAt(iso(today, -20), 6)];
    const e = detectStreakEvent(dates, ALL7, today);
    expect(e.current).toBe(7);
    expect(e.isMilestone).toBe(true);
    expect(e.isRecord).toBe(true);
    expect(e.kind).toBe('both');
  });

  it('milestone that is not yet a meaningful record stays milestone', () => {
    const today = '2026-09-30';
    // ended run of 2 + current run of 3 → 3 is a milestone; record threshold not met
    const dates = [...runEndingAt(today, 3), ...runEndingAt(iso(today, -20), 2)];
    const e = detectStreakEvent(dates, ALL7, today);
    expect(e.isMilestone).toBe(true);
    expect(e.isRecord).toBe(false);
    expect(e.kind).toBe('milestone');
  });
});

describe('detectStreakEvent — respects practice days (weekday-aware)', () => {
  const monday = '2026-01-05'; // 2026-01-01 is a Thursday → 05 is a Monday
  const weekdays = [1, 2, 3, 4, 5];

  it('a weekend gap does not break the streak', () => {
    // Thu 01, Fri 02, (Sat/Sun skipped), Mon 05
    const e = detectStreakEvent(['2026-01-01', '2026-01-02', '2026-01-05'], weekdays, monday);
    expect(e.current).toBe(3);
  });

  it('practicing on a non-routine (rest) day is neutral — does not extend', () => {
    // add Saturday 03 as a bonus day: still 3, not 4
    const e = detectStreakEvent(
      ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05'],
      weekdays,
      monday,
    );
    expect(e.current).toBe(3);
  });
});
