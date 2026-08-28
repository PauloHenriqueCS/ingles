import { describe, it, expect } from 'vitest';
import { decideCelebrationLevel } from '../decideCelebrationLevel';
import type { ObligatoryCompletion, ObligatoryFeatures } from '../celebration-types';

const ALL: ObligatoryFeatures = { writing: true, pronunciation: true, listening: true };
const NONE_DONE: ObligatoryCompletion = { writing: false, pronunciation: false, listening: false };

describe('decideCelebrationLevel', () => {
  it('a real completion that is NOT the last obligatory → activity-complete', () => {
    // writing just finished; pronunciation + listening still pending.
    const r = decideCelebrationLevel({
      features: ALL,
      completion: { ...NONE_DONE, writing: true },
      justFinished: 'writing',
    });
    expect(r.level).toBe('activity-complete');
    expect(r.completedCount).toBe(1);
    expect(r.totalCount).toBe(3);
  });

  it('the LAST obligatory activity of the day → day-complete (never activity)', () => {
    // writing + pronunciation already done; listening just finished.
    const r = decideCelebrationLevel({
      features: ALL,
      completion: { writing: true, pronunciation: true, listening: true },
      justFinished: 'listening',
    });
    expect(r.level).toBe('day-complete');
    expect(r.completedCount).toBe(3);
    expect(r.totalCount).toBe(3);
  });

  it('single configured activity → completing it goes straight to day-complete', () => {
    const r = decideCelebrationLevel({
      features: { writing: false, pronunciation: false, listening: true },
      completion: { ...NONE_DONE, listening: true },
      justFinished: 'listening',
    });
    expect(r.level).toBe('day-complete');
    expect(r.completedCount).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it('returns exactly ONE level — never both activity and day', () => {
    const r = decideCelebrationLevel({
      features: ALL,
      completion: { writing: true, pronunciation: true, listening: true },
      justFinished: 'listening',
    });
    expect(['day-complete', 'activity-complete']).toContain(r.level);
  });

  it('a non-obligatory activity (conversation/review) can never complete a day', () => {
    // Even if all three obligatory are already done, finishing conversation
    // reports activity-complete — the day-complete was (or will be) owned by the
    // obligatory transition, not this one.
    const r = decideCelebrationLevel({
      features: ALL,
      completion: { writing: true, pronunciation: true, listening: true },
      justFinished: 'conversation',
    });
    expect(r.level).toBe('activity-complete');
  });

  it('a day with no obligatory activity enabled never auto-completes', () => {
    const r = decideCelebrationLevel({
      features: { writing: false, pronunciation: false, listening: false },
      completion: { ...NONE_DONE, writing: true },
      justFinished: 'writing',
    });
    expect(r.level).toBe('activity-complete');
    expect(r.totalCount).toBe(0);
  });

  it('mid-day: two of three done → activity-complete with 2/3', () => {
    const r = decideCelebrationLevel({
      features: ALL,
      completion: { writing: true, pronunciation: true, listening: false },
      justFinished: 'pronunciation',
    });
    expect(r.level).toBe('activity-complete');
    expect(r.completedCount).toBe(2);
    expect(r.totalCount).toBe(3);
  });
});
