import type { SupabaseClient } from '@supabase/supabase-js';
import type { MissionStatus } from '../domain/missions/mission-status';
import type { MissionTransitionSource } from '../domain/missions/mission-transition-reasons';

export interface RecordTransitionInput {
  missionId: string;
  userId: string;
  fromStatus: MissionStatus;
  toStatus: MissionStatus;
  source: MissionTransitionSource;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export async function recordMissionTransition(
  supabase: SupabaseClient,
  input: RecordTransitionInput,
): Promise<void> {
  const { error } = await supabase.from('mission_status_history').insert({
    mission_id: input.missionId,
    user_id: input.userId,
    from_status: input.fromStatus,
    to_status: input.toStatus,
    source: input.source,
    reason: input.reason,
    metadata: input.metadata,
    transitioned_at: new Date().toISOString(),
  });

  if (error) throw new Error(`Failed to record mission transition: ${error.message}`);
}
