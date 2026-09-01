/**
 * SERVER-ONLY, best-effort attribution hook. Called from each SERVER-
 * authoritative activity completion point to associate a just-completed
 * activity with a recent behavioral push (association, NOT causality).
 *
 * Contract (spec): the failure of push tracking must NEVER make an activity
 * fail for the user. This function therefore NEVER throws, is idempotent
 * (first activity wins, enforced in SQL), and is isolated (its own service
 * client, swallowed errors). Fire-and-forget: callers do `void
 * recordBehavioralPushActivityConversion(...)` after their completion write.
 */

import { getSharedServiceClient } from '../_ai-gateway/index';

export type BehavioralPushActivityType =
  | 'writing'
  | 'pronunciation'
  | 'listening'
  | 'review'
  | 'conversation';

export async function recordBehavioralPushActivityConversion(
  userId: string | null | undefined,
  activityType: BehavioralPushActivityType,
  completedAt: Date = new Date(),
): Promise<void> {
  try {
    if (!userId) return;
    const supabase = getSharedServiceClient();
    await supabase.rpc('record_behavioral_push_activity_conversion', {
      p_user_id: userId,
      p_activity_type: activityType,
      p_completed_at: completedAt.toISOString(),
    });
  } catch {
    // Swallow — tracking is best-effort and must never affect the activity.
  }
}
