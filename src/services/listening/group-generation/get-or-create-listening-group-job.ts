import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningLevelGroup } from '../listening-level-group';
import { determineNextListeningGroupTargetLevel } from './determine-next-listening-group-target-level';
import { findReusableListeningGroupStory } from './find-reusable-listening-group-story';
import {
  STEP_LABELS, STEP_PROGRESS, NON_BLOCKING_STATUSES,
  rowToListeningGenerationJob,
} from './listening-group-generation-types';
import type { ListeningGenerationJob } from './listening-group-generation-types';

const JOB_COLUMNS = '*';

export type GetOrCreateListeningGroupJobResult =
  | { kind: 'reused'; episodeId: string }
  | { kind: 'active'; job: ListeningGenerationJob }
  | { kind: 'created'; job: ListeningGenerationJob };

/**
 * Entry point for "give me shared content for this level_group":
 *
 *  1. If a job is already active (not ready/failed/cancelled), return it so
 *     the caller can keep polling process-next — this is what makes two
 *     concurrent requests for the same group converge on one pipeline.
 *  2. Otherwise, determine the alternated target level and check whether a
 *     published shared story already covers it. If so, reuse it — no new
 *     OpenAI/Azure pipeline is started.
 *  3. Otherwise, attempt to atomically create a new job. The partial unique
 *     index on level_group (see migration) is the actual concurrency lock:
 *     if two callers race here, exactly one insert succeeds and the loser
 *     re-fetches and reuses the winner's job instead of erroring.
 */
export async function getOrCreateListeningGroupJob(
  supabase: SupabaseClient,
  levelGroup: ListeningLevelGroup,
): Promise<GetOrCreateListeningGroupJobResult> {
  const active = await fetchActiveJob(supabase, levelGroup);
  if (active) return { kind: 'active', job: active };

  const targetLevel = await determineNextListeningGroupTargetLevel(supabase, levelGroup);

  const reusable = await findReusableListeningGroupStory(supabase, levelGroup, targetLevel);
  if (reusable) return { kind: 'reused', episodeId: reusable.episodeId };

  const idempotencyKey = `${levelGroup}:${targetLevel}:${Date.now()}`;
  const { data: created, error } = await supabase
    .from('listening_generation_jobs')
    .insert({
      level_group: levelGroup,
      target_level: targetLevel,
      idempotency_key: idempotencyKey,
      status: 'created',
      current_step: STEP_LABELS.created,
      progress_percent: STEP_PROGRESS.created,
    })
    .select(JOB_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      const raced = await fetchActiveJob(supabase, levelGroup);
      if (raced) return { kind: 'active', job: raced };
    }
    throw new Error(`Failed to create listening group generation job: ${error.message}`);
  }

  if (!created) {
    throw new Error('Failed to create listening group generation job: no row returned');
  }

  return { kind: 'created', job: rowToListeningGenerationJob(created as Parameters<typeof rowToListeningGenerationJob>[0]) };
}

async function fetchActiveJob(
  supabase: SupabaseClient,
  levelGroup: ListeningLevelGroup,
): Promise<ListeningGenerationJob | null> {
  const { data, error } = await supabase
    .from('listening_generation_jobs')
    .select(JOB_COLUMNS)
    .eq('level_group', levelGroup)
    .not('status', 'in', `(${[...NON_BLOCKING_STATUSES].map(s => `"${s}"`).join(',')})`)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up active listening group generation job: ${error.message}`);
  }

  return data ? rowToListeningGenerationJob(data as Parameters<typeof rowToListeningGenerationJob>[0]) : null;
}
