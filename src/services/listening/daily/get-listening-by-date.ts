import type { SupabaseClient } from '@supabase/supabase-js';
import type { ByDateListeningResponse } from './listening-daily-types';

export async function getListeningByDate(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<ByDateListeningResponse> {
  const { data } = await supabase
    .from('user_listening_assignments')
    .select('id, episode_id, activity_date, status, created_at')
    .eq('user_id', userId)
    .eq('activity_date', date)
    .order('created_at', { ascending: false });

  const rows = data ?? [];
  if (rows.length === 0) return { status: 'no_assignment' };

  // With multi-story plans a day can hold several rows: prefer whichever is
  // still active, else fall back to the most recently created one.
  const chosen = rows.find((row: any) => row.status !== 'completed') ?? rows[0];

  const activityDate = typeof chosen.activity_date === 'string'
    ? chosen.activity_date.slice(0, 10)
    : chosen.activity_date;

  return {
    status:       chosen.status,
    assignmentId: chosen.id,
    episodeId:    chosen.episode_id ?? '',
    activityDate,
  };
}
