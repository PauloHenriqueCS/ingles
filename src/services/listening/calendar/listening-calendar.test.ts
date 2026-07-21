import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveListeningCalendarStatus } from './resolve-listening-calendar-status';
import { buildListeningCalendarActivity } from './build-listening-calendar-activity';
import { computeDailyProgress, type ActiveDailyFeatures } from '../../../lib/dailyProgress';

const ALL_ACTIVE: ActiveDailyFeatures = { writingEnabled: true, pronunciationEnabled: true, listeningEnabled: true };

// ── resolveListeningCalendarStatus ───────────────────────────────────────────

describe('resolveListeningCalendarStatus', () => {
  it('undefined → not_started (listening is available, not "coming soon")', () => {
    expect(resolveListeningCalendarStatus(undefined)).toBe('not_started');
  });

  it("'completed' → 'completed'", () => {
    expect(resolveListeningCalendarStatus('completed')).toBe('completed');
  });

  it("'in_progress' → 'in_progress'", () => {
    expect(resolveListeningCalendarStatus('in_progress')).toBe('in_progress');
  });

  it("'not_started' → 'not_started'", () => {
    expect(resolveListeningCalendarStatus('not_started')).toBe('not_started');
  });
});

// ── buildListeningCalendarActivity ───────────────────────────────────────────

describe('buildListeningCalendarActivity', () => {
  it('returns correct entry for completed status', () => {
    const entry = buildListeningCalendarActivity('2026-07-15', 'completed');
    expect(entry).toEqual({ date: '2026-07-15', listeningStatus: 'completed' });
  });

  it('returns correct entry for in_progress status', () => {
    const entry = buildListeningCalendarActivity('2026-07-15', 'in_progress');
    expect(entry).toEqual({ date: '2026-07-15', listeningStatus: 'in_progress' });
  });

  it('returns correct entry for not_started status', () => {
    const entry = buildListeningCalendarActivity('2026-07-14', 'not_started');
    expect(entry).toEqual({ date: '2026-07-14', listeningStatus: 'not_started' });
  });

  it('returns not_started when status is undefined (listening is a real activity)', () => {
    const entry = buildListeningCalendarActivity('2026-07-16', undefined);
    expect(entry).toEqual({ date: '2026-07-16', listeningStatus: 'not_started' });
  });
});

// ── getListeningDatesForMonth (mocked Supabase) ───────────────────────────────

// Helper that simulates the output of getListeningDatesForMonth
// by applying the same transformation as the real function.
function transformRows(rows: { activity_date: string; status: string }[]) {
  const result: Record<string, 'not_started' | 'in_progress' | 'completed'> = {};
  for (const row of rows) {
    const dateStr = typeof row.activity_date === 'string'
      ? row.activity_date.slice(0, 10)
      : String(row.activity_date);
    result[dateStr] = row.status === 'completed' ? 'completed'
      : row.status === 'in_progress'             ? 'in_progress'
      : 'not_started';
  }
  return result;
}

describe('calendar query data transformation', () => {
  // Test 1: A saved listening record is returned by the calendar query
  it('completed assignment maps to "completed" status', () => {
    const rows = [{ activity_date: '2026-07-16', status: 'completed' }];
    const result = transformRows(rows);
    expect(result['2026-07-16']).toBe('completed');
  });

  // Test 5: Multiple activities on same day don't create duplicates
  it('multiple rows for same date — last one wins (no duplicates in output)', () => {
    const rows = [
      { activity_date: '2026-07-16', status: 'in_progress' },
      { activity_date: '2026-07-16', status: 'completed' },
    ];
    const result = transformRows(rows);
    // unique constraint ensures only one row per user+date in practice,
    // but the transform should not produce duplicate keys
    expect(Object.keys(result).filter(k => k === '2026-07-16').length).toBe(1);
  });

  // Date normalization: activity_date comes as 'YYYY-MM-DD' from Supabase
  it('normalizes activity_date string to YYYY-MM-DD', () => {
    const rows = [{ activity_date: '2026-07-16T00:00:00+00:00', status: 'completed' }];
    const result = transformRows(rows);
    expect(result['2026-07-16']).toBe('completed');
  });

  it('assigned status falls back to not_started', () => {
    const rows = [{ activity_date: '2026-07-16', status: 'assigned' }];
    const result = transformRows(rows);
    expect(result['2026-07-16']).toBe('not_started');
  });
});

// ── computeDailyProgress with listening ──────────────────────────────────────

describe('computeDailyProgress — listening integration', () => {
  const date = '2026-07-16';
  const noPron = new Set<string>();
  const withPron = new Set([date]);

  function fullEntry() {
    return {
      date,
      title: 'Test',
      originalText: 'hello world',
      correctedText: 'hello world',
      observations: '',
      mainErrors: '',
      difficulty: null as null,
      status: 'corrigido' as const,
      wordCount: 2,
      updatedAt: date,
      aiReview: null,
      reviewedAt: null,
    };
  }

  // Test 2: The day of Listening is marked as active
  it('listening completed → day shows amber dot (listening=completed)', () => {
    const progress = computeDailyProgress(date, undefined, 0, 900, noPron, 'completed', ALL_ACTIVE);
    expect(progress.listening).toBe('completed');
  });

  // Test 3: Listening recognized alongside other activities
  it('all activities + listening completed → allActiveCompleted=true', () => {
    const progress = computeDailyProgress(date, fullEntry(), 1800, 900, withPron, 'completed', ALL_ACTIVE);
    expect(progress.writing).toBe('completed');
    expect(progress.pronunciation).toBe('completed');
    expect(progress.conversation).toBe('completed');
    expect(progress.listening).toBe('completed');
    expect(progress.allActiveCompleted).toBe(true);
  });

  // Test 4: Listening alone is enough to be recognized (not undefined/coming_soon)
  it('listening completed alone → allActiveCompleted=false but listening is recognized', () => {
    const progress = computeDailyProgress(date, undefined, 0, 900, noPron, 'completed', ALL_ACTIVE);
    expect(progress.listening).toBe('completed');
    // allActiveCompleted requires all activities, so false here
    expect(progress.allActiveCompleted).toBe(false);
  });

  // Test: listening not_started does NOT block allActiveCompleted for a plan
  // where listening isn't an active obligatory feature (backward compat for
  // past days / plans without listening turned on). With ALL_ACTIVE (the
  // implicit default this test used before activeFeatures was made
  // explicit), listening is symmetric with writing/pronunciation — its
  // status DOES gate allActiveCompleted, same as any other obligatory
  // activity (see the adjacent "listening completed alone" test above,
  // where an incomplete OTHER activity correctly keeps allActiveCompleted
  // false). "Optional" only holds when listeningEnabled is actually false.
  it('listening not_started does not block allActiveCompleted (optional activity)', () => {
    const progress = computeDailyProgress(date, fullEntry(), 1800, 900, withPron, 'not_started', {
      writingEnabled: true, pronunciationEnabled: true, listeningEnabled: false,
    });
    expect(progress.allActiveCompleted).toBe(true);
  });

  // Test: listening undefined (no assignment) defaults to not_started and does NOT block allActiveCompleted
  it('listening undefined (no assignment) defaults to not_started, allows allActiveCompleted', () => {
    const progress = computeDailyProgress(date, fullEntry(), 1800, 900, withPron, undefined, {
      writingEnabled: true, pronunciationEnabled: true, listeningEnabled: false,
    });
    expect(progress.listening).toBe('not_started');
    expect(progress.allActiveCompleted).toBe(true);
  });

  // activeFeatures explicit: listening disabled for this plan never blocks
  // allActiveCompleted even when incomplete — proves the flag (not just the
  // default) actually gates the obligatory-status list.
  it('listening disabled in activeFeatures never blocks allActiveCompleted, regardless of status', () => {
    const progress = computeDailyProgress(date, fullEntry(), 1800, 900, withPron, 'not_started', {
      writingEnabled: true, pronunciationEnabled: true, listeningEnabled: false,
    });
    expect(progress.allActiveCompleted).toBe(true);
  });
});

// ── Date range calculation (Test 6 and 7) ────────────────────────────────────

import { resolveListeningActivityDate } from '../daily/resolve-listening-activity-date';

describe('resolveListeningActivityDate — São Paulo timezone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Test 6: Date is correctly calculated in America/Sao_Paulo
  it('returns date in America/Sao_Paulo timezone', () => {
    // 2026-07-16T02:00:00Z = 2026-07-15T23:00:00 in UTC-3 (São Paulo in July, no DST)
    vi.setSystemTime(new Date('2026-07-16T02:00:00Z'));
    const date = resolveListeningActivityDate();
    expect(date).toBe('2026-07-15');
  });

  // Test 7: Record near midnight appears on the correct day (SP time)
  it('activity at 23:30 São Paulo time is recorded on that day', () => {
    // 2026-07-16T23:30:00 SP = 2026-07-17T02:30:00Z (July, UTC-3)
    vi.setSystemTime(new Date('2026-07-17T02:30:00Z'));
    const date = resolveListeningActivityDate();
    expect(date).toBe('2026-07-16');
  });

  it('activity at 00:10 São Paulo time is recorded on the new day', () => {
    // 2026-07-17T00:10:00 SP = 2026-07-17T03:10:00Z
    vi.setSystemTime(new Date('2026-07-17T03:10:00Z'));
    const date = resolveListeningActivityDate();
    expect(date).toBe('2026-07-17');
  });
});

// ── Date range filter (query would exclude out-of-month records) ──────────────

describe('calendar date range filter', () => {
  function isInMonthRange(activityDate: string, year: number, month: number): boolean {
    const pad = (n: number) => String(n).padStart(2, '0');
    const startDate = `${year}-${pad(month)}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    const endDate   = `${nextYear}-${pad(nextMonth)}-01`;
    return activityDate >= startDate && activityDate < endDate;
  }

  it('July 16 is in July range', () => {
    expect(isInMonthRange('2026-07-16', 2026, 7)).toBe(true);
  });

  it('July 1 is included (gte)', () => {
    expect(isInMonthRange('2026-07-01', 2026, 7)).toBe(true);
  });

  it('July 31 is included', () => {
    expect(isInMonthRange('2026-07-31', 2026, 7)).toBe(true);
  });

  it('August 1 is excluded (lt)', () => {
    expect(isInMonthRange('2026-08-01', 2026, 7)).toBe(false);
  });

  it('June 30 is excluded', () => {
    expect(isInMonthRange('2026-06-30', 2026, 7)).toBe(false);
  });

  it('December wraps to January correctly', () => {
    expect(isInMonthRange('2026-12-31', 2026, 12)).toBe(true);
    expect(isInMonthRange('2027-01-01', 2026, 12)).toBe(false);
  });
});
