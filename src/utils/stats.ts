import { EntriesStore, DashboardStats, MonthStats } from '../types';
import { getWeekdaysInMonth } from '../data/calendar2026';

function isWritten(entry: { status: string; originalText: string } | undefined): boolean {
  if (!entry) return false;
  return entry.status !== 'nao-iniciado' && entry.originalText.trim().length > 0;
}

export function computeStats(entries: EntriesStore, today: Date = new Date()): DashboardStats {
  const todayStr = today.toISOString().split('T')[0];
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();

  const writtenEntries = Object.values(entries).filter((e) => isWritten(e));

  const textsThisMonth = writtenEntries.filter((e) => {
    const d = new Date(e.date + 'T12:00:00');
    return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear;
  }).length;

  const textsThisYear = writtenEntries.filter((e) => {
    return new Date(e.date + 'T12:00:00').getFullYear() === currentYear;
  }).length;

  // All 2026 weekdays up to today
  const allWeekdays: string[] = [];
  for (let m = 1; m <= 12; m++) {
    allWeekdays.push(...getWeekdaysInMonth(2026, m));
  }
  const weekdaysUpToToday = allWeekdays.filter((d) => d <= todayStr).sort();

  let currentStreak = 0;
  for (let i = weekdaysUpToToday.length - 1; i >= 0; i--) {
    const d = weekdaysUpToToday[i];
    if (isWritten(entries[d])) {
      currentStreak++;
    } else if (d < todayStr) {
      break;
    }
  }

  let bestStreak = 0;
  let tempStreak = 0;
  for (const d of weekdaysUpToToday) {
    if (isWritten(entries[d])) {
      tempStreak++;
      if (tempStreak > bestStreak) bestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }

  const totalWords = writtenEntries.reduce((sum, e) => sum + (e.wordCount || 0), 0);
  const avgWords = writtenEntries.length > 0 ? Math.round(totalWords / writtenEntries.length) : 0;

  const monthlyStats: MonthStats[] = [];
  for (let m = 1; m <= 12; m++) {
    const weekdays = getWeekdaysInMonth(2026, m);
    const writtenDays = weekdays.filter((d) => isWritten(entries[d]));
    const monthWords = writtenDays.reduce((sum, d) => sum + (entries[d]?.wordCount || 0), 0);
    monthlyStats.push({ month: m, year: 2026, written: writtenDays.length, total: weekdays.length, totalWords: monthWords });
  }

  return { textsThisMonth, textsThisYear, currentStreak, bestStreak, totalWords, avgWords, monthlyStats };
}
