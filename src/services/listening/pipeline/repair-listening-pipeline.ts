import type { SupabaseClient } from '@supabase/supabase-js';
import { LISTENING_JOB_TYPES } from '../jobs/listening-job-types';
import { JOB_PRIORITY } from '../jobs/listening-job-config';
import { enqueueListeningJob } from '../jobs/enqueue-listening-job';

export type RepairListeningPipelineResult = {
  episodeId: string;
  repaired:  boolean;
  action:    string;
};

// ── Repair a pipeline that got stuck ─────────────────────────────────────────
// Checks the episode's current component statuses and creates the appropriate
// missing job to resume processing.

export async function repairListeningPipeline(
  supabase: SupabaseClient,
  episodeId: string,
): Promise<RepairListeningPipelineResult> {
  const { data: episode, error } = await supabase
    .from('listening_episodes')
    .select('id, status, cefr_level, questions_status, subtitles_status, ssml_status, audio_status, timing_status')
    .eq('id', episodeId)
    .maybeSingle();

  if (error || !episode) {
    return { episodeId, repaired: false, action: 'episode_not_found' };
  }

  // Do not repair published or archived episodes
  if (episode.status === 'published' || episode.status === 'archived') {
    return { episodeId, repaired: false, action: 'episode_immutable' };
  }

  const V = 'repair';
  const prio = JOB_PRIORITY.URGENT;

  // Check for existing active jobs for this episode
  const { data: activeJobs } = await supabase
    .from('listening_jobs')
    .select('job_type')
    .eq('episode_id', episodeId)
    .in('status', ['pending', 'processing', 'retry']);

  const activeJobTypes = new Set((activeJobs ?? []).map((j: { job_type: string }) => j.job_type));

  // Determine what step is missing and create the appropriate job

  // Story is missing (episode in draft with no content)
  if (episode.status === 'draft' && !activeJobTypes.has(LISTENING_JOB_TYPES.GENERATE_LISTENING_STORY)) {
    const result = await enqueueListeningJob(supabase, {
      jobType:        LISTENING_JOB_TYPES.REPAIR_LISTENING_EPISODE,
      idempotencyKey: `${LISTENING_JOB_TYPES.REPAIR_LISTENING_EPISODE}:${episodeId}:${Date.now()}`,
      payload:        { jobType: LISTENING_JOB_TYPES.REPAIR_LISTENING_EPISODE, episodeId },
      episodeId,
      priority:       prio,
    });
    return { episodeId, repaired: result.created, action: 'enqueued_repair_job' };
  }

  // Questions not ready and no active questions job
  if (
    episode.questions_status !== 'valid' &&
    !activeJobTypes.has(LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS)
  ) {
    const key = `${LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS}:${episodeId}:${V}`;
    const result = await enqueueListeningJob(supabase, {
      jobType:        LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS,
      idempotencyKey: key,
      payload:        { jobType: LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS, episodeId },
      episodeId,
      priority:       prio,
    });
    return { episodeId, repaired: result.created, action: 'enqueued_questions' };
  }

  // Subtitles not ready
  if (
    episode.subtitles_status !== 'ready' &&
    !activeJobTypes.has(LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES)
  ) {
    const key = `${LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES}:${episodeId}:${V}`;
    const result = await enqueueListeningJob(supabase, {
      jobType:        LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES,
      idempotencyKey: key,
      payload:        { jobType: LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES, episodeId },
      episodeId,
      priority:       prio,
    });
    return { episodeId, repaired: result.created, action: 'enqueued_subtitles' };
  }

  // SSML not ready
  if (
    episode.ssml_status !== 'ready' &&
    !activeJobTypes.has(LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML)
  ) {
    const key = `${LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML}:${episodeId}:${V}`;
    const result = await enqueueListeningJob(supabase, {
      jobType:        LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML,
      idempotencyKey: key,
      payload:        { jobType: LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML, episodeId },
      episodeId,
      priority:       prio,
    });
    return { episodeId, repaired: result.created, action: 'enqueued_ssml' };
  }

  // Audio not ready — check individual blocks
  if (episode.audio_status !== 'ready') {
    const { data: blocks } = await supabase
      .from('listening_blocks')
      .select('id, block_order, audio_status')
      .eq('episode_id', episodeId)
      .order('block_order');

    for (const block of blocks ?? []) {
      if (
        block.audio_status !== 'validated' &&
        !activeJobTypes.has(LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO)
      ) {
        const key = `${LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO}:${episodeId}:${block.id}:${V}`;
        await enqueueListeningJob(supabase, {
          jobType:        LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO,
          idempotencyKey: key,
          payload: {
            jobType:    LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO,
            episodeId,
            blockId:    block.id,
            blockOrder: block.block_order as 1 | 2,
          },
          episodeId,
          blockId:  block.id,
          priority: prio,
        });
      }
    }
    return { episodeId, repaired: true, action: 'enqueued_audio' };
  }

  // Timing not ready
  if (episode.timing_status !== 'timed') {
    const { data: blocks } = await supabase
      .from('listening_blocks')
      .select('id, block_order, timing_status')
      .eq('episode_id', episodeId)
      .order('block_order');

    for (const block of blocks ?? []) {
      if (
        block.timing_status !== 'timed' &&
        !activeJobTypes.has(LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK)
      ) {
        const key = `${LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK}:${episodeId}:${block.id}:${V}`;
        await enqueueListeningJob(supabase, {
          jobType:        LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK,
          idempotencyKey: key,
          payload: {
            jobType:    LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK,
            episodeId,
            blockId:    block.id,
            blockOrder: block.block_order as 1 | 2,
          },
          episodeId,
          blockId:  block.id,
          priority: prio,
        });
      }
    }
    return { episodeId, repaired: true, action: 'enqueued_sync' };
  }

  // Episode is ready but not published — enqueue validate + publish
  if (episode.status === 'ready' && !activeJobTypes.has(LISTENING_JOB_TYPES.PUBLISH_LISTENING_EPISODE)) {
    const key = `${LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE}:${episodeId}:${V}`;
    await enqueueListeningJob(supabase, {
      jobType:        LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE,
      idempotencyKey: key,
      payload:        { jobType: LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE, episodeId },
      episodeId,
      priority:       prio,
    });
    return { episodeId, repaired: true, action: 'enqueued_validate' };
  }

  // Active jobs already exist — no repair needed
  return { episodeId, repaired: false, action: 'no_action_needed' };
}
