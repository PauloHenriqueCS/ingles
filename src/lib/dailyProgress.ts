import { supabase } from './supabase';
import { DailyActivityStatus, DailyProgress, DayEntry } from '../types';
import { toSpDate } from './timezone';

export async function getPronunciationDatesForMonth(
  year: number,
  month: number,
): Promise<Set<string>> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const startUTC = `${year}-${pad(month)}-01T00:00:00Z`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endUTC = `${nextYear}-${pad(nextMonth)}-02T05:00:00Z`;

  const { data } = await supabase
    .from('pronunciation_assessments')
    .select('completed_at')
    .eq('status', 'completed')
    .gte('completed_at', startUTC)
    .lt('completed_at', endUTC);

  const dates = new Set<string>();
  for (const row of data ?? []) {
    if (row.completed_at) {
      dates.add(toSpDate(row.completed_at as string));
    }
  }
  return dates;
}

function writingStatus(entry: DayEntry | undefined): DailyActivityStatus {
  if (!entry?.originalText?.trim()) return 'not_started';
  if (entry.status === 'corrigido' || entry.status === 'revisado') return 'completed';
  return 'in_progress';
}

function conversationStatus(totalSec: number, goalSec: number): DailyActivityStatus {
  if (totalSec <= 0) return 'not_started';
  if (totalSec >= goalSec) return 'completed';
  return 'in_progress';
}

export function computeDailyProgress(
  date: string,
  entry: DayEntry | undefined,
  convTotalSec: number,
  convGoalSec: number,
  pronunciationDates: Set<string>,
  listeningStatus?: 'not_started' | 'in_progress' | 'completed',
): DailyProgress {
  const writing = writingStatus(entry);
  const pronunciation: DailyActivityStatus = pronunciationDates.has(date)
    ? 'completed'
    : 'not_started';
  const conversation = conversationStatus(convTotalSec, convGoalSec);
  const listening: DailyActivityStatus = listeningStatus ?? 'coming_soon';

  const allActiveCompleted =
    writing === 'completed' &&
    pronunciation === 'completed' &&
    conversation === 'completed' &&
    (listening === 'completed' || listening === 'coming_soon');

  return { date, writing, pronunciation, conversation, listening, allActiveCompleted };
}
