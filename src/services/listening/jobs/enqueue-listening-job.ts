import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningJobType, ListeningJobPayload } from './listening-job-types';
import { MAX_ATTEMPTS, DEFAULT_PRIORITY } from './listening-job-config';

export type EnqueueListeningJobInput = {
  jobType:        ListeningJobType;
  idempotencyKey: string;
  payload:        ListeningJobPayload;
  episodeId?:     string | null;
  blockId?:       string | null;
  cefrLevel?:     string | null;
  priority?:      number;
  maxAttempts?:   number;
};

export type EnqueueListeningJobResult = {
  jobId:   string;
  created: boolean; // false = already existed (idempotent)
};

export async function enqueueListeningJob(
  supabase: SupabaseClient,
  input: EnqueueListeningJobInput,
): Promise<EnqueueListeningJobResult> {
  const { jobType, idempotencyKey, payload, episodeId, blockId, cefrLevel, priority, maxAttempts } = input;

  // Check for existing active/completed job with same idempotency key
  const { data: existing } = await supabase
    .from('listening_jobs')
    .select('id, status')
    .eq('idempotency_key', idempotencyKey)
    .not('status', 'in', '("cancelled","dead_letter")')
    .maybeSingle();

  if (existing) {
    return { jobId: existing.id, created: false };
  }

  const { data, error } = await supabase
    .from('listening_jobs')
    .insert({
      job_type:        jobType,
      status:          'pending',
      priority:        priority ?? DEFAULT_PRIORITY[jobType],
      episode_id:      episodeId ?? null,
      block_id:        blockId ?? null,
      cefr_level:      cefrLevel ?? null,
      payload,
      idempotency_key: idempotencyKey,
      max_attempts:    maxAttempts ?? MAX_ATTEMPTS[jobType],
      next_attempt_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    // Race condition: another process inserted the same key between our check and insert
    if (error.code === '23505') {
      const { data: raceExisting } = await supabase
        .from('listening_jobs')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .not('status', 'in', '("cancelled","dead_letter")')
        .maybeSingle();
      if (raceExisting) return { jobId: raceExisting.id, created: false };
    }
    throw new Error(`Failed to enqueue ${jobType} job: ${error.message}`);
  }

  console.error(JSON.stringify({
    event: 'listening_job_created',
    jobId: data.id,
    jobType,
    episodeId: episodeId ?? null,
    blockId: blockId ?? null,
    cefrLevel: cefrLevel ?? null,
    idempotencyKey,
    t: Date.now(),
  }));

  return { jobId: data.id, created: true };
}
