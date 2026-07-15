import type { SupabaseClient } from '@supabase/supabase-js';

export type CancelListeningPipelineResult = {
  episodeId:      string;
  cancelledCount: number;
  reason:         string;
};

export async function cancelListeningPipeline(
  supabase: SupabaseClient,
  episodeId: string,
  reason:    string = 'admin_cancel',
): Promise<CancelListeningPipelineResult> {
  // Check episode status — do not cancel published episodes
  const { data: episode } = await supabase
    .from('listening_episodes')
    .select('id, status')
    .eq('id', episodeId)
    .maybeSingle();

  if (!episode) {
    return { episodeId, cancelledCount: 0, reason: 'episode_not_found' };
  }

  if (episode.status === 'published') {
    return { episodeId, cancelledCount: 0, reason: 'episode_is_published' };
  }

  // Cancel pending/retry jobs (do not interrupt processing jobs)
  const { data: cancelled, error } = await supabase
    .from('listening_jobs')
    .update({
      status:      'cancelled',
      error_code:  'PIPELINE_CANCELLED',
      error_message: reason.slice(0, 200),
      finished_at: new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .eq('episode_id', episodeId)
    .in('status', ['pending', 'retry'])
    .select('id');

  if (error) {
    throw new Error(`Failed to cancel pipeline for episode ${episodeId}: ${error.message}`);
  }

  const cancelledCount = cancelled?.length ?? 0;

  console.error(JSON.stringify({
    event:          'listening_pipeline_cancelled',
    episodeId,
    cancelledCount,
    reason,
    t: Date.now(),
  }));

  return { episodeId, cancelledCount, reason };
}
