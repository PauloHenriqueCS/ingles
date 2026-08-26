import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRACTICE_REMINDER,
  WEEKDAY_ORDER,
  PRACTICE_REMINDER_ID_BASE,
  PRACTICE_REMINDER_IDS,
  practiceReminderIdForIsoDay,
  isPracticeReminderId,
  normalizeWeekdays,
  normalizePreference,
  isActionable,
  isoToPluginWeekday,
  formatTime,
  parseTime,
  summarizeWeekdays,
} from '../practiceReminder';

describe('weekday domain', () => {
  it('lists Monday→Sunday as ISO 1..7', () => {
    expect([...WEEKDAY_ORDER]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('maps ISO weekdays to the plugin enum (Sunday=1, Monday=2, … Saturday=7)', () => {
    expect(isoToPluginWeekday(1)).toBe(2); // Mon
    expect(isoToPluginWeekday(2)).toBe(3); // Tue
    expect(isoToPluginWeekday(3)).toBe(4); // Wed
    expect(isoToPluginWeekday(4)).toBe(5); // Thu
    expect(isoToPluginWeekday(5)).toBe(6); // Fri
    expect(isoToPluginWeekday(6)).toBe(7); // Sat
    expect(isoToPluginWeekday(7)).toBe(1); // Sun
  });

  it('normalizes: dedupe, sort, drop out-of-range/garbage', () => {
    expect(normalizeWeekdays([5, 1, 1, 3, 3])).toEqual([1, 3, 5]);
    expect(normalizeWeekdays([0, 8, -1, 9])).toEqual([]);
    expect(normalizeWeekdays([2.9, 4])).toEqual([2, 4]);
    expect(normalizeWeekdays(null)).toEqual([]);
    expect(normalizeWeekdays(undefined)).toEqual([]);
  });
});

describe('deterministic notification ids', () => {
  it('derives a stable id per ISO weekday from the reserved base', () => {
    expect(practiceReminderIdForIsoDay(1)).toBe(PRACTICE_REMINDER_ID_BASE + 1);
    expect(practiceReminderIdForIsoDay(7)).toBe(PRACTICE_REMINDER_ID_BASE + 7);
  });

  it('reserves exactly 7 ids (Mon..Sun), all recognized as ours', () => {
    expect(PRACTICE_REMINDER_IDS).toHaveLength(7);
    for (const id of PRACTICE_REMINDER_IDS) expect(isPracticeReminderId(id)).toBe(true);
  });

  it('does not claim ids outside its range', () => {
    expect(isPracticeReminderId(PRACTICE_REMINDER_ID_BASE)).toBe(false);
    expect(isPracticeReminderId(PRACTICE_REMINDER_ID_BASE + 8)).toBe(false);
    expect(isPracticeReminderId(1)).toBe(false);
  });
});

describe('normalizePreference', () => {
  it('coerces untrusted stored values into a valid preference', () => {
    expect(
      normalizePreference({ enabled: true, weekdays: [3, 1, 1], hour: 99, minute: -5 }),
    ).toEqual({ enabled: true, weekdays: [1, 3], hour: 23, minute: 0 });
  });

  it('falls back to defaults for missing fields', () => {
    expect(normalizePreference(null)).toEqual(DEFAULT_PRACTICE_REMINDER);
    expect(normalizePreference({})).toEqual(DEFAULT_PRACTICE_REMINDER);
  });
});

describe('isActionable', () => {
  it('is true only when enabled AND ≥1 weekday', () => {
    expect(isActionable({ enabled: true, weekdays: [1], hour: 8, minute: 0 })).toBe(true);
    expect(isActionable({ enabled: true, weekdays: [], hour: 8, minute: 0 })).toBe(false);
    expect(isActionable({ enabled: false, weekdays: [1, 2], hour: 8, minute: 0 })).toBe(false);
  });
});

describe('time formatting', () => {
  it('formats/parses HH:MM (24h), zero-padded and clamped', () => {
    expect(formatTime(9, 5)).toBe('09:05');
    expect(formatTime(19, 30)).toBe('19:30');
    expect(formatTime(99, 99)).toBe('23:59');
    expect(parseTime('07:45')).toEqual({ hour: 7, minute: 45 });
    expect(parseTime('')).toEqual({ hour: 19, minute: 30 });
  });
});

describe('summarizeWeekdays', () => {
  const short = (d: number) => ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'][d - 1];
  it('joins with commas + a final conjunction, in Mon→Sun order', () => {
    expect(summarizeWeekdays([5, 1, 3], short, 'e')).toBe('Seg, Qua e Sex');
    expect(summarizeWeekdays([2], short, 'e')).toBe('Ter');
    expect(summarizeWeekdays([1, 7], short, 'and')).toBe('Seg and Dom');
    expect(summarizeWeekdays([], short, 'e')).toBe('');
  });
});
