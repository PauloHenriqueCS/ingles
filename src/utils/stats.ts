import { EntriesStore, DashboardStats, MonthStats, AIStats } from '../types';
import { getWeekdaysInMonth } from '../data/calendar2026';
import { getTodaySP } from '../lib/timezone';

function isWritten(entry: { status: string; originalText: string } | undefined): boolean {
  if (!entry) return false;
  return entry.status !== 'nao-iniciado' && entry.originalText.trim().length > 0;
}

function avg(nums: number[]): number {
  return nums.length > 0 ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

/**
 * @param todayOverride - YYYY-MM-DD date string for tests; defaults to São Paulo timezone today
 * @param activeWeekdays - day-of-week numbers (0=Sun..6=Sat) that count as practice days
 */
export function computeStats(
  entries: EntriesStore,
  todayOverride?: string | Date,
  activeWeekdays: number[] = [1, 2, 3, 4, 5],
): DashboardStats {
  let todayStr: string;
  if (typeof todayOverride === 'string') {
    todayStr = todayOverride;
  } else if (todayOverride instanceof Date) {
    // Legacy: accept Date objects from existing tests — use ISO slice
    todayStr = todayOverride.toISOString().split('T')[0];
  } else {
    todayStr = getTodaySP();
  }

  const currentMonth = parseInt(todayStr.slice(5, 7), 10);
  const currentYear = parseInt(todayStr.slice(0, 4), 10);

  const writtenEntries = Object.values(entries).filter((e) => isWritten(e));

  const textsThisMonth = writtenEntries.filter((e) => {
    const d = new Date(e.date + 'T12:00:00');
    return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear;
  }).length;

  const textsThisYear = writtenEntries.filter((e) => {
    return new Date(e.date + 'T12:00:00').getFullYear() === currentYear;
  }).length;

  const allWeekdays: string[] = [];
  for (let m = 1; m <= 12; m++) {
    allWeekdays.push(...getWeekdaysInMonth(currentYear, m, activeWeekdays));
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
    const weekdays = getWeekdaysInMonth(currentYear, m, activeWeekdays);
    const writtenDays = weekdays.filter((d) => isWritten(entries[d]));
    const monthWords = writtenDays.reduce((sum, d) => sum + (entries[d]?.wordCount || 0), 0);
    monthlyStats.push({ month: m, year: currentYear, written: writtenDays.length, total: weekdays.length, totalWords: monthWords });
  }

  const reviewedEntries = writtenEntries.filter((e) => e.aiReview != null);

  const monthlyAvgScores = [];
  for (let m = 1; m <= 12; m++) {
    const monthReviewed = reviewedEntries.filter((e) => {
      const d = new Date(e.date + 'T12:00:00');
      return d.getMonth() + 1 === m && d.getFullYear() === currentYear;
    });
    monthlyAvgScores.push({
      month: m,
      avgScore: avg(monthReviewed.map((e) => e.aiReview!.score)),
      count: monthReviewed.length,
    });
  }

  const latestReviewed = reviewedEntries
    .filter((e) => e.reviewedAt)
    .sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''));

  const aiStats: AIStats = {
    reviewedCount: reviewedEntries.length,
    avgScore: avg(reviewedEntries.map((e) => e.aiReview!.score)),
    avgGrammar: avg(reviewedEntries.map((e) => e.aiReview!.grammar)),
    avgVocabulary: avg(reviewedEntries.map((e) => e.aiReview!.vocabulary)),
    avgNaturalness: avg(reviewedEntries.map((e) => e.aiReview!.naturalness)),
    avgFluency: avg(reviewedEntries.map((e) => e.aiReview!.fluency)),
    latestLevel: latestReviewed[0]?.aiReview?.level ?? null,
    monthlyAvgScores,
  };

  return { textsThisMonth, textsThisYear, currentStreak, bestStreak, totalWords, avgWords, monthlyStats, aiStats };
}
