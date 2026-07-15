import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningJobResult } from './listening-job-types';

export async function completeListeningJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  result: ListeningJobResult,
): Promise<void> {
  const { error } = await supabase
    .from('listening_jobs')
    .update({
      status:          'completed',
      result,
      locked_by:       null,
      locked_at:       null,
      lock_expires_at: null,
      finished_at:     new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('locked_by', workerId)
    .eq('status', 'processing');

  if (error) {
    throw new Error(`Failed to complete job ${jobId}: ${error.message}`);
  }
}
