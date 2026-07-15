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

  const { data } = await clientSupabase
    .from('user_listening_assignments')
    .select('activity_date, status')
    .gte('activity_date', startDate)
    .lt('activity_date', endDate);

  const result: Record<string, ListeningCalendarStatus> = {};
  for (const row of data ?? []) {
    const dateStr = typeof row.activity_date === 'string'
      ? row.activity_date.slice(0, 10)
      : String(row.activity_date);
    result[dateStr] = row.status === 'completed' ? 'completed'
      : row.status === 'in_progress'             ? 'in_progress'
      : 'not_started';
  }
  return result;
}
