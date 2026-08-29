import { describe, it, expect } from 'vitest';
import {
  decideBehavioralPush,
  countMissedConfiguredDays,
  weekdayOf,
  BEHAVIORAL_PUSH,
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

describe('countMissedConfiguredDays', () => {
  it('counts only configured weekdays after the reference, skipping non-configured ones', () => {
    // Mon/Wed/Fri configured; last practice Fri 09-04; today Wed 09-09.
    // Configured days in (09-04, 09-09]: Mon 09-07, Wed 09-09 → 2 (Tue not counted).
    const missed = countMissedConfiguredDays([1, 3, 5], [], '2026-09-04', '2026-09-09');
    expect(missed).toBe(2);
  });

  it('excludes days already active', () => {
    const missed = countMissedConfiguredDays(MON_FRI, ['2026-09-08'], '2026-09-04', '2026-09-09');
    // (09-04, 09-09] weekdays = Mon07, Tue08, Wed09 → Tue08 active → 2 missed.
    expect(missed).toBe(2);
  });
});

describe('decideBehavioralPush — anti-nag & configured-day gates', () => {
  it('case 1: practiced today → no push', () => {
    const d = decideBehavioralPush(input({ practicedToday: true, activeDates: ['2026-09-07'] }));
    expect(d.pushType).toBeNull();
  });

  it('case 2: practiced writing today (nothing else) still counts as practiced → no push', () => {
    // practicedToday is the generous "any activity today" flag → true.
    const d = decideBehavioralPush(input({ practicedToday: true }));
    expect(d.pushType).toBeNull();
  });

  it('case 3: today is not a configured practice day → no push (even with a streak)', () => {
    const d = decideBehavioralPush(
      input({ localDate: '2026-09-12', activeDates: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'] }),
    );
    expect(d.pushType).toBeNull();
  });
});

describe('decideBehavioralPush — streak_risk', () => {
  it('case 4: live streak on an unfinished configured day → streak_risk', () => {
    const activeDates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
    const d = decideBehavioralPush(input({ localDate: '2026-09-14', activeDates }));
    expect(d.pushType).toBe('streak_risk');
    expect(d.streak).toBe(5);
  });

  it('streak snapshot equals computeWeekdayStreak exactly (single algorithm)', () => {
    const activeDates = ['2026-09-07', '2026-09-09', '2026-09-10', '2026-09-11'];
    const d = decideBehavioralPush(input({ localDate: '2026-09-14', activeDates }));
    expect(d.streak).toBe(computeWeekdayStreak(activeDates, '2026-09-14', MON_FRI));
  });

  it('case 5: streak_risk takes priority — abandonment is never returned while streak > 0', () => {
    const activeDates = ['2026-09-11']; // streak 1 as of Mon 09-14
    const d = decideBehavioralPush(input({ localDate: '2026-09-14', activeDates }));
    expect(d.pushType).toBe('streak_risk');
  });
});

describe('decideBehavioralPush — abandonment', () => {
  it('case 7: two consecutive missed configured days → abandonment', () => {
    // last practice Fri 09-04; today Tue 09-08; Mon07 + Tue08 missed = 2.
    const d = decideBehavioralPush(input({ localDate: '2026-09-08', activeDates: ['2026-09-04'] }));
    expect(d.pushType).toBe('abandonment');
    expect(d.streak).toBe(0);
    expect(d.missedStudyDays).toBe(2);
  });

  it('case 8: intermediate non-configured days do not count toward abandonment', () => {
    // Mon/Wed/Fri configured; last practice Fri 09-04; today Wed 09-09.
    const d = decideBehavioralPush(
      input({ activeWeekdays: [1, 3, 5], localDate: '2026-09-09', activeDates: ['2026-09-04'] }),
    );
    expect(d.pushType).toBe('abandonment');
    expect(d.missedStudyDays).toBe(2);
  });

  it('case 6: a single missed configured day is not yet abandonment', () => {
    // Threshold check via the count: only 1 missed configured day.
    const missed = countMissedConfiguredDays(MON_FRI, [], '2026-09-07', '2026-09-08');
    expect(missed).toBe(1);
    expect(BEHAVIORAL_PUSH.MISSED_PRACTICE_DAYS_FOR_ABANDONMENT).toBe(2);
    expect(missed).toBeLessThan(BEHAVIORAL_PUSH.MISSED_PRACTICE_DAYS_FOR_ABANDONMENT);
  });

  it('never-practiced user: abandonment after >= 2 configured days since signup', () => {
    const d = decideBehavioralPush(
      input({ activeDates: [], accountCreatedDate: '2026-09-07', localDate: '2026-09-11' }),
    );
    expect(d.pushType).toBe('abandonment');
    expect(d.missedStudyDays).toBe(4); // Tue,Wed,Thu,Fri
  });

  it('never-practiced user: not premature (only 1 configured day since signup)', () => {
    const d = decideBehavioralPush(
      input({ activeDates: [], accountCreatedDate: '2026-09-07', localDate: '2026-09-08' }),
    );
    expect(d.pushType).toBeNull();
  });
});
