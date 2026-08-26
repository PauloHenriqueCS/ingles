/**
 * Pure domain for the Practice Reminder feature — NO React, NO Supabase, NO
 * Capacitor. Everything here is deterministic and unit-testable in isolation:
 * the preference shape, weekday domain/normalization, validation, the mapping
 * to the local-notifications weekday, and the DETERMINISTIC notification IDs
 * that make (re)scheduling idempotent.
 *
 * Weekday domain: ISO-8601, 1=Monday … 7=Sunday. This is the single canonical
 * representation stored in Postgres and used across the UI; it is mapped to the
 * plugin's own weekday enum only at schedule time (isoToPluginWeekday).
 */

export interface PracticeReminderPreference {
  enabled: boolean;
  /** ISO days 1=Mon..7=Sun, normalized (unique, sorted, in range). */
  weekdays: number[];
  /** Local hour 0..23. */
  hour: number;
  /** Local minute 0..59. */
  minute: number;
}

export const DEFAULT_PRACTICE_REMINDER: PracticeReminderPreference = {
  enabled: false,
  weekdays: [],
  hour: 19,
  minute: 30,
};

/** ISO weekdays in display order: Monday → Sunday. */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Reserved, deterministic notification-ID base for the Practice Reminder. Each
 * scheduled reminder uses PRACTICE_REMINDER_ID_BASE + isoDay (so Mon→…101,
 * Sun→…107). Because the id is derived from the weekday (never random), saving
 * the same config twice overwrites the same 7 slots instead of piling up
 * duplicates, and we can cancel EXACTLY our own reminders (this range only)
 * without touching notifications scheduled by any other feature.
 */
export const PRACTICE_REMINDER_ID_BASE = 920100;

/** The full set of ids this feature may ever own (Mon..Sun). */
export const PRACTICE_REMINDER_IDS: readonly number[] = WEEKDAY_ORDER.map(
  (d) => PRACTICE_REMINDER_ID_BASE + d,
);

export function practiceReminderIdForIsoDay(isoDay: number): number {
  return PRACTICE_REMINDER_ID_BASE + isoDay;
}

/** True when a notification id belongs to this feature's reserved range. */
export function isPracticeReminderId(id: number): boolean {
  return id > PRACTICE_REMINDER_ID_BASE && id <= PRACTICE_REMINDER_ID_BASE + 7;
}

/** Clamp + dedupe + sort weekday input to the canonical ISO 1..7 domain. */
export function normalizeWeekdays(input: readonly number[] | null | undefined): number[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<number>();
  for (const raw of input) {
    const d = Math.trunc(Number(raw));
    if (Number.isFinite(d) && d >= 1 && d <= 7) seen.add(d);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Coerce any partial/untrusted stored value into a valid preference object. */
export function normalizePreference(
  input: Partial<PracticeReminderPreference> | null | undefined,
): PracticeReminderPreference {
  const hour = clampInt(input?.hour, 0, 23, DEFAULT_PRACTICE_REMINDER.hour);
  const minute = clampInt(input?.minute, 0, 59, DEFAULT_PRACTICE_REMINDER.minute);
  return {
    enabled: Boolean(input?.enabled),
    weekdays: normalizeWeekdays(input?.weekdays),
    hour,
    minute,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * A preference is "actionable" (should produce native schedules) only when it
 * is enabled AND has at least one weekday. An enabled-but-empty preference is
 * NOT a valid active state (mirrors the UI validation and the DB CHECK).
 */
export function isActionable(pref: PracticeReminderPreference): boolean {
  return pref.enabled && normalizeWeekdays(pref.weekdays).length >= 1;
}

/**
 * Map an ISO weekday (1=Mon..7=Sun) to the @capacitor/local-notifications
 * ScheduleOn.weekday enum (1=Sunday, 2=Monday, … 7=Saturday). Verified:
 *   Mon(1)→2, Tue(2)→3, … Sat(6)→7, Sun(7)→1.
 */
export function isoToPluginWeekday(isoDay: number): number {
  return (isoDay % 7) + 1;
}

/** "9:5" → "09:05" — 24h local time for the UI summary and <input type="time">. */
export function formatTime(hour: number, minute: number): string {
  const h = String(clampInt(hour, 0, 23, 0)).padStart(2, '0');
  const m = String(clampInt(minute, 0, 59, 0)).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Parse an <input type="time"> value "HH:MM" into {hour, minute}, clamped. A
 * missing/blank/malformed value (e.g. the field was cleared) falls back to the
 * default time rather than silently jumping to midnight.
 */
export function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) {
    return { hour: DEFAULT_PRACTICE_REMINDER.hour, minute: DEFAULT_PRACTICE_REMINDER.minute };
  }
  return {
    hour: clampInt(match[1], 0, 23, DEFAULT_PRACTICE_REMINDER.hour),
    minute: clampInt(match[2], 0, 59, DEFAULT_PRACTICE_REMINDER.minute),
  };
}

/**
 * Build a human day list like "Seg, Qua e Sex" using caller-provided labels and
 * conjunction, in canonical Mon→Sun order. Pure — the labels/word come from the
 * i18n layer so this stays language-agnostic.
 */
export function summarizeWeekdays(
  weekdays: readonly number[],
  labelFor: (isoDay: number) => string,
  conjunction: string,
): string {
  const days = normalizeWeekdays([...weekdays]).map(labelFor);
  if (days.length === 0) return '';
  if (days.length === 1) return days[0];
  const head = days.slice(0, -1).join(', ');
  const tail = days[days.length - 1];
  return `${head} ${conjunction} ${tail}`;
}
