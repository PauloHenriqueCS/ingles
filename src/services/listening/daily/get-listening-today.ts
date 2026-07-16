import type { SupabaseClient } from '@supabase/supabase-js';
import { buildListeningEpisodeSession } from '../execution/build-listening-episode-session';
import { resolveListeningActivityDate } from './resolve-listening-activity-date';
import { resolveUserListeningLevel } from './resolve-user-listening-level';
import { selectListeningEpisodeForUser } from './select-listening-episode-for-user';
import { getOrCreateListeningAssignment } from './get-or-create-listening-assignment';
import { updateListeningAssignmentStatus } from './update-listening-assignment-status';
import type { TodayListeningResponse } from './listening-daily-types';

export async function getListeningToday(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayListeningResponse> {
  const activityDate = resolveListeningActivityDate();

  // Check for existing assignment today
  const { data: existing } = await supabase
    .from('user_listening_assignments')
    .select('*')
    .eq('user_id', userId)
    .eq('activity_date', activityDate)
    .maybeSingle();

  let assignmentId: string;
  let episodeId: string;
  let currentStatus: string;

  if (existing) {
    if (!existing.episode_id) {
      // Story-mode completion recorded for today — no episode session to load.
      return { status: 'story_completed', assignmentId: existing.id, activityDate };
    }
    assignmentId  = existing.id;
    episodeId     = existing.episode_id;
    currentStatus = existing.status;
  } else {
    const cefrLevel = await resolveUserListeningLevel(supabase, userId);
    const selectedId = await selectListeningEpisodeForUser(supabase, userId, cefrLevel);
    if (!selectedId) return { status: 'empty_inventory' };

    const { assignment } = await getOrCreateListeningAssignment(supabase, {
      userId, episodeId: selectedId, activityDate,
    });
    assignmentId  = assignment.id;
    episodeId     = assignment.episodeId;
    currentStatus = assignment.status;
  }

  // Build session (handles completed episodes gracefully)
  const session = await buildListeningEpisodeSession(episodeId, userId, supabase);

  // Determine resolved status
  const isCompleted = !!session.progress?.completedAt;
  const resolvedStatus = isCompleted ? 'completed'
    : currentStatus === 'assigned' ? 'in_progress'
    : (currentStatus as 'in_progress' | 'completed');

  // Update status if transitioning to in_progress
  if (currentStatus === 'assigned' && !isCompleted) {
    await updateListeningAssignmentStatus(supabase, assignmentId, 'in_progress');
  }
  if (isCompleted && currentStatus !== 'completed') {
    await updateListeningAssignmentStatus(supabase, assignmentId, 'completed');
  }

  return { status: resolvedStatus, assignmentId, episodeId, activityDate, session };
}
