import type { SupabaseClient } from '@supabase/supabase-js';
import { buildListeningEpisodeSession } from '../execution/build-listening-episode-session';
import { resolveListeningActivityDate } from './resolve-listening-activity-date';
import { updateListeningAssignmentStatus } from './update-listening-assignment-status';
import type { TodayListeningResponse } from './listening-daily-types';

export async function getListeningToday(
  supabase: SupabaseClient,
  userId: string,
  /** Unused by this function — kept so the call site (api/listening/[...slug].ts) doesn't need to change. */
  _serviceClient: SupabaseClient,
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

  // Data-driven cutover: the legacy pre-generated `listening_episodes` inventory
  // (level-indexed, hardcoded-authored, and NOT recorte-aligned — it also never
  // recorded curricular practice) is NO LONGER selected for NEW practice. The
  // sole authority for a new listening practice is the data-driven curriculum
  // Story path (api/listening/generate → shared-story → listening.two_part_
  // generate, composed for the user's CURRENT recorte, which records curricular
  // practice). Returning `empty_inventory` makes the client fall through to that
  // path. In-progress legacy episodes are still resumed below purely as
  // historical continuity (never a new hardcoded-pedagogy selection).
  const activeRow = rows.find((row: any) => row.status !== 'completed');
  if (!activeRow) {
    return { status: 'empty_inventory' };
  }

  const assignmentId  = activeRow.id as string;
  const episodeId     = activeRow.episode_id as string;
  const currentStatus = activeRow.status as string;

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
