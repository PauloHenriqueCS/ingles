import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningJob } from '../jobs/listening-job-types';
import { LISTENING_JOB_TYPES } from '../jobs/listening-job-types';
import { JOB_PRIORITY } from '../jobs/listening-job-config';
import { enqueueListeningJob } from '../jobs/enqueue-listening-job';

const V = 'v1'; // pipeline version — bump to re-run completed steps

// ── Advance pipeline after a job completes ────────────────────────────────────
//
// Chain:
//   STORY → QUESTIONS → SUBTITLES → SSML
//   SSML  → AUDIO(block1) + AUDIO(block2)    (parallel)
//   AUDIO(blockN) → when both validated → SYNC(block1) + SYNC(block2)
//   SYNC(blockN)  → when both timed    → VALIDATE
//   VALIDATE → PUBLISH
//   PUBLISH  → done (log pipeline_completed)

export async function advanceListeningPipeline(
  supabase: SupabaseClient,
  completedJob: ListeningJob,
): Promise<void> {
  const jobType = completedJob.job_type;

  switch (jobType) {

    // ── Story → Questions ──────────────────────────────────────────────────
    case LISTENING_JOB_TYPES.GENERATE_LISTENING_STORY: {
      const episodeId = (completedJob.result?.episodeId as string | undefined)
        ?? completedJob.episode_id;
      if (!episodeId) return;

      await enqueueListeningJob(supabase, {
        jobType:        LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS,
        idempotencyKey: `${LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS}:${episodeId}:${V}`,
        payload:        { jobType: LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS, episodeId },
        episodeId,
        cefrLevel:      completedJob.cefr_level,
        priority:       JOB_PRIORITY.NORMAL,
      });
      break;
    }

    // ── Questions → Subtitles ──────────────────────────────────────────────
    case LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS: {
      const episodeId = completedJob.episode_id;
      if (!episodeId) return;

      await enqueueListeningJob(supabase, {
        jobType:        LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES,
        idempotencyKey: `${LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES}:${episodeId}:${V}`,
        payload:        { jobType: LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES, episodeId },
        episodeId,
        cefrLevel:      completedJob.cefr_level,
        priority:       JOB_PRIORITY.NORMAL,
      });
      break;
    }

    // ── Subtitles → SSML ───────────────────────────────────────────────────
    case LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES: {
      const episodeId = completedJob.episode_id;
      if (!episodeId) return;

      await enqueueListeningJob(supabase, {
        jobType:        LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML,
        idempotencyKey: `${LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML}:${episodeId}:${V}`,
        payload:        { jobType: LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML, episodeId },
        episodeId,
        cefrLevel:      completedJob.cefr_level,
        priority:       JOB_PRIORITY.NORMAL,
      });
      break;
    }

    // ── SSML → Audio (both blocks in parallel) ─────────────────────────────
    case LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML: {
      const episodeId = completedJob.episode_id;
      if (!episodeId) return;

      const blocks = await loadBlocks(supabase, episodeId);
      for (const block of blocks) {
        await enqueueListeningJob(supabase, {
          jobType: LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO,
          idempotencyKey: `${LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO}:${episodeId}:${block.id}:${V}`,
          payload: {
            jobType:    LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO,
            episodeId,
            blockId:    block.id,
            blockOrder: block.block_order as 1 | 2,
          },
          episodeId,
          blockId:   block.id,
          cefrLevel: completedJob.cefr_level,
          priority:  JOB_PRIORITY.HIGH,
        });
      }
      break;
    }

    // ── Audio block N → when both validated → Sync (both blocks) ──────────
    case LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO: {
      const episodeId = completedJob.episode_id;
      if (!episodeId) return;

      const blocks = await loadBlocks(supabase, episodeId);
      const bothAudioReady = await checkBothBlocksAudioValidated(supabase, blocks.map(b => b.id));
      if (!bothAudioReady) break;

      for (const block of blocks) {
        await enqueueListeningJob(supabase, {
          jobType: LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK,
          idempotencyKey: `${LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK}:${episodeId}:${block.id}:${V}`,
          payload: {
            jobType:    LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK,
            episodeId,
            blockId:    block.id,
            blockOrder: block.block_order as 1 | 2,
          },
          episodeId,
          blockId:   block.id,
          cefrLevel: completedJob.cefr_level,
          priority:  JOB_PRIORITY.HIGH,
        });
      }
      break;
    }

    // ── Sync block N → when both timed → Validate ─────────────────────────
    case LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK: {
      const episodeId = completedJob.episode_id;
      if (!episodeId) return;

      const blocks = await loadBlocks(supabase, episodeId);
      const bothSynced = await checkBothBlocksSynced(supabase, episodeId, blocks);
      if (!bothSynced) break;

      await enqueueListeningJob(supabase, {
        jobType:        LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE,
        idempotencyKey: `${LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE}:${episodeId}:${V}`,
        payload:        { jobType: LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE, episodeId },
        episodeId,
        cefrLevel: completedJob.cefr_level,
        priority:  JOB_PRIORITY.HIGH,
      });
      break;
    }

    // ── Validate → Publish ─────────────────────────────────────────────────
    case LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE: {
      const episodeId = completedJob.episode_id;
      if (!episodeId) return;

      await enqueueListeningJob(supabase, {
        jobType:        LISTENING_JOB_TYPES.PUBLISH_LISTENING_EPISODE,
        idempotencyKey: `${LISTENING_JOB_TYPES.PUBLISH_LISTENING_EPISODE}:${episodeId}:${V}`,
        payload:        { jobType: LISTENING_JOB_TYPES.PUBLISH_LISTENING_EPISODE, episodeId },
        episodeId,
        cefrLevel: completedJob.cefr_level,
        priority:  JOB_PRIORITY.HIGH,
      });
      break;
    }

    // ── Publish → done ─────────────────────────────────────────────────────
    case LISTENING_JOB_TYPES.PUBLISH_LISTENING_EPISODE: {
      console.error(JSON.stringify({
        event:     'listening_pipeline_completed',
        episodeId: completedJob.episode_id,
        cefrLevel: completedJob.cefr_level,
        t: Date.now(),
      }));
      break;
    }

    // Other job types have no pipeline successor
    default:
      break;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function loadBlocks(
  supabase: SupabaseClient,
  episodeId: string,
): Promise<Array<{ id: string; block_order: number }>> {
  const { data, error } = await supabase
    .from('listening_blocks')
    .select('id, block_order')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (error) throw new Error(`Failed to load blocks for episode ${episodeId}: ${error.message}`);
  return (data ?? []) as Array<{ id: string; block_order: number }>;
}

async function checkBothBlocksAudioValidated(
  supabase: SupabaseClient,
  blockIds: string[],
): Promise<boolean> {
  if (blockIds.length !== 2) return false;

  const { data, error } = await supabase
    .from('listening_audio_assets')
    .select('block_id')
    .in('block_id', blockIds)
    .eq('status', 'validated');

  if (error) return false;

  // Count distinct block_ids that have validated audio
  const validatedBlockIds = new Set((data ?? []).map((r: { block_id: string }) => r.block_id));
  return validatedBlockIds.size === 2;
}

async function checkBothBlocksSynced(
  supabase: SupabaseClient,
  episodeId: string,
  blocks: Array<{ id: string; block_order: number }>,
): Promise<boolean> {
  if (blocks.length !== 2) return false;

  const { data, error } = await supabase
    .from('listening_blocks')
    .select('id, timing_status')
    .eq('episode_id', episodeId);

  if (error) return false;

  const syncedCount = (data ?? []).filter(
    (b: { timing_status: string | null }) => b.timing_status === 'timed',
  ).length;

  return syncedCount === 2;
}
