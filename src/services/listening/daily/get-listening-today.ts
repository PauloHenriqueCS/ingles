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

  // Fetch every assignment for today — with multi-story plans a user can
  // have more than one row per day (one per distinct episode).
  const { data: todaysAssignments } = await supabase
    .from('user_listening_assignments')
    .select('*')
    .eq('user_id', userId)
    .eq('activity_date', activityDate)
    .order('created_at', { ascending: false });

  const rows = todaysAssignments ?? [];

  // Story-mode completion (episode_id null) is a separate, single-per-day
  // activity that never participates in the multi-story episode limit.
  const storyModeRow = rows.find((row: any) => !row.episode_id);
  if (storyModeRow) {
    return { status: 'story_completed', assignmentId: storyModeRow.id, activityDate };
  }

  let assignmentId: string;
  let episodeId: string;
  let currentStatus: string;

  // Continue whatever story is still in progress before offering a new one.
  const activeRow = rows.find((row: any) => row.status !== 'completed');

  if (activeRow) {
    assignmentId  = activeRow.id;
    episodeId     = activeRow.episode_id;
    currentStatus = activeRow.status;
  } else {
    // Nothing active today: entitlements already gated whether the caller
    // is allowed to start another one (see api/listening/[...slug].ts).
    const excludeEpisodeIds = rows
      .map((row: any) => row.episode_id as string | null)
      .filter((id: string | null): id is string => !!id);
    const cefrLevel = await resolveUserListeningLevel(supabase, userId);
    const selectedId = await selectListeningEpisodeForUser(supabase, userId, cefrLevel, excludeEpisodeIds);
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
