import { supabase as clientSupabase } from '../../../lib/supabase';

type ListeningCalendarStatus = 'not_started' | 'in_progress' | 'completed';

const STATUS_RANK: Record<ListeningCalendarStatus, number> = { not_started: 0, in_progress: 1, completed: 2 };

export async function getListeningDatesForMonth(
  year: number,
  month: number,
): Promise<Record<string, ListeningCalendarStatus>> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const startDate = `${year}-${pad(month)}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear  = month === 12 ? year + 1 : year;
  const endDate   = `${nextYear}-${pad(nextMonth)}-01`;

  console.log('[CALENDAR_QUERY_RESULT] querying user_listening_assignments', { startDate, endDate });

  const { data, error } = await clientSupabase
    .from('user_listening_assignments')
    .select('activity_date, status')
    .gte('activity_date', startDate)
    .lt('activity_date', endDate);

  if (error) {
    console.warn('[CALENDAR_QUERY_RESULT] query error', { message: error.message });
  } else {
    console.log('[CALENDAR_QUERY_RESULT] rows returned', { count: data?.length ?? 0 });
  }

  const result: Record<string, ListeningCalendarStatus> = {};
  for (const row of data ?? []) {
    const dateStr = typeof row.activity_date === 'string'
      ? row.activity_date.slice(0, 10)
      : String(row.activity_date);

    console.log('[CALENDAR_DATE_NORMALIZED]', { raw: row.activity_date, normalized: dateStr, status: row.status });

    const rowStatus: ListeningCalendarStatus = row.status === 'completed' ? 'completed'
      : row.status === 'in_progress'                                     ? 'in_progress'
      : 'not_started';

    // A day can hold several rows on multi-story plans — keep whichever
    // status ranks highest instead of letting the last row win arbitrarily.
    const current = result[dateStr];
    if (!current || STATUS_RANK[rowStatus] > STATUS_RANK[current]) {
      console.log('[CALENDAR_LISTENING_FOUND]', { date: dateStr, status: rowStatus });
      result[dateStr] = rowStatus;
    } else {
      console.log('[CALENDAR_LISTENING_IGNORED]', { date: dateStr, status: rowStatus, reason: 'lower_rank_than_existing' });
    }
  }

  console.log('[CALENDAR_ACTIVITY_TYPES]', { completedDates: Object.entries(result).filter(([, s]) => s === 'completed').map(([d]) => d) });

  return result;
}
