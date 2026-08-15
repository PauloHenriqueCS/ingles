import { DaySchedule } from '../types';

/**
 * Calendar SCHEDULING + date/UI helpers.
 *
 * DATA-DRIVEN CUTOVER: this module no longer carries any pedagogical authority.
 * The old per-month grammar/level/tense catalog and the weekday writing-topic
 * lists were removed — level, grammar, verb tense and the pedagogical sequence
 * are now governed exclusively by the persisted curriculum (see
 * src/domain/curriculum-engine + api/_curriculum). What remains here is purely
 * WHICH days are practice days (scheduling) and calendar date/label helpers for
 * the month/history UI — no bundled English pedagogy.
 */

export function getScheduleForDate(
  dateStr: string,
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
  overrideDates: string[] = []
): DaySchedule | null {
  const date = new Date(dateStr + 'T12:00:00');

  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const isPracticeDay = activeWeekdays.includes(dow) || overrideDates.includes(dateStr);

  if (!isPracticeDay) {
    const weekendActivity = dow === 0 ? 'descanso' : dow === 6 ? 'revisao' : undefined;
    return { date: dateStr, isWeekend, isPracticeDay: false, weekendActivity };
  }

  return { date: dateStr, isWeekend, isPracticeDay: true };
}

export function getAllDatesInMonth(year: number, month: number): string[] {
  const dates: string[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(
      `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    );
  }
  return dates;
}

export function getWeekdaysInMonth(
  year: number,
  month: number,
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
  overrideDates: string[] = []
): string[] {
  return getAllDatesInMonth(year, month).filter((dateStr) => {
    const dow = new Date(dateStr + 'T12:00:00').getDay();
    return activeWeekdays.includes(dow) || overrideDates.includes(dateStr);
  });
}

export const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
