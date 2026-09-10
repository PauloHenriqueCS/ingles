import { describe, it, expect } from 'vitest';
import {
  decideBehavioralPush,
  countMissedConfiguredDays,
  weekdayOf,
  DAILY_PRACTICE_PUSH_TYPE,
  type BehavioralPushCandidateInput,
} from './behavioralPushDomain';
import { computeWeekdayStreak } from '../../src/lib/metricsCore';

// Reference week (2026): Mon 09-07, Tue 09-08, Wed 09-09, Thu 09-10, Fri 09-11,
// Sat 09-12, Sun 09-13, Mon 09-14. Prior Fri = 09-04.
const MON_FRI = [1, 2, 3, 4, 5];

function input(overrides: Partial<BehavioralPushCandidateInput>): BehavioralPushCandidateInput {
  return {
    userId: 'u1',
    activeWeekdays: MON_FRI,
    activeDates: [],
    practicedToday: false,
    accountCreatedDate: '2026-01-01',
    localDate: '2026-09-14',
    ...overrides,
  };
}

describe('weekdayOf', () => {
  it('is timezone-independent and 0=Sun..6=Sat', () => {
    expect(weekdayOf('2026-09-13')).toBe(0); // Sun
    expect(weekdayOf('2026-09-14')).toBe(1); // Mon
    expect(weekdayOf('2026-09-12')).toBe(6); // Sat
  });
});

describe('countMissedConfiguredDays (pure helper, retained)', () => {
  it('counts only configured weekdays after the reference, skipping non-configured ones', () => {
    const missed = countMissedConfiguredDays([1, 3, 5], [], '2026-09-04', '2026-09-09');
    expect(missed).toBe(2);
  });

  it('excludes days already active', () => {
    const missed = countMissedConfiguredDays(MON_FRI, ['2026-09-08'], '2026-09-04', '2026-09-09');
    expect(missed).toBe(2);
  });
});

describe('decideBehavioralPush — v2 daily practice reminder', () => {
  // A. configured practice day + not practiced today → eligible.
  it('A: configured day + not practiced → practice_reminder_behavioral', () => {
    const d = decideBehavioralPush(input({ localDate: '2026-09-14' /* Mon */ }));
    expect(d.pushType).toBe(DAILY_PRACTICE_PUSH_TYPE);
    expect(d.pushType).toBe('practice_reminder_behavioral');
    expect(d.missedStudyDays).toBe(0);
  });

  // B. already practiced today → not eligible (generous anti-nag flag).
  it('B: practiced today → no push', () => {
    const d = decideBehavioralPush(input({ practicedToday: true }));
    expect(d.pushType).toBeNull();
  });

  it('B2: a below-goal conversation still counts as practiced (generous) → no push', () => {
    // practicedToday encodes the generous "any activity today" gate → true.
    const d = decideBehavioralPush(input({ practicedToday: true, activeDates: [] }));
    expect(d.pushType).toBeNull();
  });

  // C. today is not a configured practice day → not eligible (even with a streak).
  it('C: non-configured day → no push even with a live streak', () => {
    const d = decideBehavioralPush(
      input({
        localDate: '2026-09-12', // Sat, not in MON_FRI
        activeDates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
      }),
    );
    expect(d.pushType).toBeNull();
  });

  it('eligibility does NOT depend on streak: streak 0 on a configured day is still eligible', () => {
    const d = decideBehavioralPush(input({ localDate: '2026-09-14', activeDates: [] }));
    expect(d.pushType).toBe('practice_reminder_behavioral');
    expect(d.streak).toBe(0);
  });

  it('streak snapshot equals computeWeekdayStreak exactly (single algorithm, snapshot only)', () => {
    const activeDates = ['2026-09-07', '2026-09-09', '2026-09-10', '2026-09-11'];
    const d = decideBehavioralPush(input({ localDate: '2026-09-14', activeDates }));
    expect(d.streak).toBe(computeWeekdayStreak(activeDates, '2026-09-14', MON_FRI));
    // …but the streak never changes the decision.
    expect(d.pushType).toBe('practice_reminder_behavioral');
  });
});
