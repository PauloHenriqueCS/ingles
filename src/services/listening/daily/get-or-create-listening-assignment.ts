import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningAssignment } from './listening-daily-types';

function rowToAssignment(row: any): ListeningAssignment {
  return {
    id:           row.id,
    userId:       row.user_id,
    episodeId:    row.episode_id,
    activityDate: typeof row.activity_date === 'string' ? row.activity_date.slice(0, 10) : row.activity_date,
    status:       row.status,
    assignedAt:   row.assigned_at,
    startedAt:    row.started_at ?? null,
    completedAt:  row.completed_at ?? null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

export async function getOrCreateListeningAssignment(
  supabase: SupabaseClient,
  params: { userId: string; episodeId: string; activityDate: string },
): Promise<{ assignment: ListeningAssignment; created: boolean }> {
  const { userId, episodeId, activityDate } = params;

  const { data: existing } = await supabase
    .from('user_listening_assignments')
    .select('*')
    .eq('user_id', userId)
    .eq('activity_date', activityDate)
    .maybeSingle();

  if (existing) return { assignment: rowToAssignment(existing), created: false };

  const { data: inserted, error } = await supabase
    .from('user_listening_assignments')
    .insert({ user_id: userId, episode_id: episodeId, activity_date: activityDate })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: race } = await supabase
        .from('user_listening_assignments')
        .select('*')
        .eq('user_id', userId)
        .eq('activity_date', activityDate)
        .maybeSingle();
      if (race) return { assignment: rowToAssignment(race), created: false };
    }
    throw new Error(`Failed to create listening assignment: ${error.message}`);
  }

  return { assignment: rowToAssignment(inserted), created: true };
}
