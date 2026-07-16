import { supabase as clientSupabase } from '../../../lib/supabase';

type ListeningCalendarStatus = 'not_started' | 'in_progress' | 'completed';

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

    if (row.status === 'completed') {
      console.log('[CALENDAR_LISTENING_FOUND]', { date: dateStr });
    } else {
      console.log('[CALENDAR_LISTENING_IGNORED]', { date: dateStr, status: row.status, reason: 'status_not_completed' });
    }

    result[dateStr] = row.status === 'completed' ? 'completed'
      : row.status === 'in_progress'             ? 'in_progress'
      : 'not_started';
  }

  console.log('[CALENDAR_ACTIVITY_TYPES]', { completedDates: Object.entries(result).filter(([, s]) => s === 'completed').map(([d]) => d) });

  return result;
}
