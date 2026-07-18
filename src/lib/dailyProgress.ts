import { supabase } from './supabase';
import { DailyActivityStatus, DailyProgress, DayEntry } from '../types';
import { toSpDate } from './timezone';
import { isConversationGoalMet } from './conversationSessions';

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
  if (isConversationGoalMet(totalSec, goalSec / 60)) return 'completed';
  return 'in_progress';
}

/** Which of the three daily-obligatory activities the user's plan has turned on. Conversation is never part of this — it is always optional for the day's color. */
export interface ActiveDailyFeatures {
  writingEnabled: boolean;
  pronunciationEnabled: boolean;
  listeningEnabled: boolean;
}

const ALL_FEATURES_ACTIVE: ActiveDailyFeatures = {
  writingEnabled: true,
  pronunciationEnabled: true,
  listeningEnabled: true,
};

export function computeDailyProgress(
  date: string,
  entry: DayEntry | undefined,
  convTotalSec: number,
  convGoalSec: number,
  pronunciationDates: Set<string>,
  listeningStatus?: 'not_started' | 'in_progress' | 'completed',
  // Defaults to "all three active" so any caller not yet passing plan info
  // keeps the pre-entitlements behavior instead of silently going green-less.
  activeFeatures: ActiveDailyFeatures = ALL_FEATURES_ACTIVE,
): DailyProgress {
  const writing = writingStatus(entry);
  const pronunciation: DailyActivityStatus = pronunciationDates.has(date)
    ? 'completed'
    : 'not_started';
  const conversation = conversationStatus(convTotalSec, convGoalSec);
  const listening: DailyActivityStatus = listeningStatus ?? 'not_started';

  // Conversation is always optional — it is deliberately never included
  // here, regardless of plan or goal state. Only writing/pronunciation/
  // listening that are actually active in the plan are obligatory; a day
  // with none of the three active never turns green automatically.
  const obligatoryStatuses: DailyActivityStatus[] = [];
  if (activeFeatures.writingEnabled) obligatoryStatuses.push(writing);
  if (activeFeatures.pronunciationEnabled) obligatoryStatuses.push(pronunciation);
  if (activeFeatures.listeningEnabled) obligatoryStatuses.push(listening);

  const allActiveCompleted =
    obligatoryStatuses.length > 0 && obligatoryStatuses.every((s) => s === 'completed');

  return { date, writing, pronunciation, conversation, listening, allActiveCompleted };
}
