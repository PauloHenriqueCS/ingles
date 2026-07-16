import type { SupabaseClient } from '@supabase/supabase-js';
import type { ByDateListeningResponse } from './listening-daily-types';

export async function getListeningByDate(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<ByDateListeningResponse> {
  const { data } = await supabase
    .from('user_listening_assignments')
    .select('id, episode_id, activity_date, status')
    .eq('user_id', userId)
    .eq('activity_date', date)
    .maybeSingle();

  if (!data) return { status: 'no_assignment' };

  const activityDate = typeof data.activity_date === 'string'
    ? data.activity_date.slice(0, 10)
    : data.activity_date;

  return {
    status:       data.status,
    assignmentId: data.id,
    episodeId:    data.episode_id ?? '',
    activityDate,
  };
}
