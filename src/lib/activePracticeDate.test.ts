import { describe, it, expect } from 'vitest';
import { getNextActivePracticeDate } from './activePracticeDate';

// 2026-01-01 is a Thursday (UTC dow = 4)
const THU = new Date('2026-01-01T12:00:00Z');

describe('getNextActivePracticeDate', () => {
  it('returns same day if already active', () => {
    const r = getNextActivePracticeDate(THU, [1, 2, 3, 4, 5]);
    expect(r.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('advances from Saturday to Monday (Mon-Fri only)', () => {
    const sat = new Date('2026-01-03T12:00:00Z'); // Saturday (6)
    const r = getNextActivePracticeDate(sat, [1, 2, 3, 4, 5]);
    expect(r.toISOString().slice(0, 10)).toBe('2026-01-05'); // Monday
  });

  it('advances from Sunday to Monday (Mon-Fri only)', () => {
    const sun = new Date('2026-01-04T12:00:00Z'); // Sunday (0)
    const r = getNextActivePracticeDate(sun, [1, 2, 3, 4, 5]);
    expect(r.toISOString().slice(0, 10)).toBe('2026-01-05'); // Monday
  });

  it('returns Saturday when Saturday is active', () => {
    const sat = new Date('2026-01-03T12:00:00Z');
    const r = getNextActivePracticeDate(sat, [1, 2, 3, 4, 5, 6]);
    expect(r.toISOString().slice(0, 10)).toBe('2026-01-03');
  });

  it('returns the input date unchanged when activeWeekdays is empty', () => {
    const r = getNextActivePracticeDate(THU, []);
    expect(r.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('works across a month boundary', () => {
    const fri = new Date('2026-01-30T12:00:00Z'); // Friday
    // Only Monday active → jump to next Monday (Feb 2)
    const r = getNextActivePracticeDate(fri, [1]);
    expect(r.toISOString().slice(0, 10)).toBe('2026-02-02');
  });

  it('finds next Sunday when only Sunday is active', () => {
    const mon = new Date('2026-01-05T12:00:00Z'); // Monday
    const r = getNextActivePracticeDate(mon, [0]);
    expect(r.toISOString().slice(0, 10)).toBe('2026-01-11'); // Next Sunday
  });

  it('does not mutate the input date', () => {
    const sat = new Date('2026-01-03T12:00:00Z');
    const original = sat.getTime();
    getNextActivePracticeDate(sat, [1, 2, 3, 4, 5]);
    expect(sat.getTime()).toBe(original);
  });
});
