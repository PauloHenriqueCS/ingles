import type { SupabaseClient } from '@supabase/supabase-js';
import type { MissionStatus } from '../domain/missions/mission-status';

export type MissionActionType = 'accept' | 'start' | 'complete' | 'skip';

export interface IdempotencyCheckResult {
  alreadyProcessed: boolean;
  previousResultStatus?: MissionStatus;
}

export async function checkAndRecordIdempotentAction(
  supabase: SupabaseClient,
  requestId: string,
  missionId: string,
  actionType: MissionActionType,
  resultStatus: MissionStatus,
): Promise<IdempotencyCheckResult> {
  // Try to insert; if conflict on request_id, fetch the existing record.
  const { data: existing, error: selectError } = await supabase
    .from('mission_action_idempotency')
    .select('result_status')
    .eq('request_id', requestId)
    .maybeSingle();

  if (selectError) throw new Error(`Idempotency check failed: ${selectError.message}`);

  if (existing) {
    return {
      alreadyProcessed: true,
      previousResultStatus: existing.result_status as MissionStatus,
    };
  }

  const { error: insertError } = await supabase.from('mission_action_idempotency').insert({
    request_id: requestId,
    mission_id: missionId,
    action_type: actionType,
    result_status: resultStatus,
    processed_at: new Date().toISOString(),
  });

  // Race condition: another request beat us to it — treat as already processed.
  if (insertError && insertError.code === '23505') {
    const { data: raceData } = await supabase
      .from('mission_action_idempotency')
      .select('result_status')
      .eq('request_id', requestId)
      .single();

    return {
      alreadyProcessed: true,
      previousResultStatus: raceData?.result_status as MissionStatus | undefined,
    };
  }

  if (insertError) throw new Error(`Failed to record idempotent action: ${insertError.message}`);

  return { alreadyProcessed: false };
}
