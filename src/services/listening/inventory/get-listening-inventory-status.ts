import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListeningInventoryLevelStatus } from '../jobs/listening-job-types';
import { INVENTORY_CONFIG } from '../jobs/listening-job-config';
import { ALL_CEFR_LEVELS } from '../../../domain/curriculum/cefr';

// Pipeline job types that indicate an episode is being generated
const PIPELINE_JOB_TYPES = [
  'GENERATE_LISTENING_STORY',
  'GENERATE_LISTENING_QUESTIONS',
  'PREPARE_LISTENING_SUBTITLES',
  'GENERATE_LISTENING_SSML',
  'SYNTHESIZE_LISTENING_BLOCK_AUDIO',
  'SYNCHRONIZE_LISTENING_BLOCK',
  'VALIDATE_LISTENING_EPISODE',
  'PUBLISH_LISTENING_EPISODE',
];

export async function getListeningInventoryStatus(
  supabase: SupabaseClient,
): Promise<ListeningInventoryLevelStatus[]> {
  // ── Published episodes per level ─────────────────────────────────────────
  const { data: publishedRows } = await supabase
    .from('listening_episodes')
    .select('cefr_level')
    .eq('status', 'published');

  const publishedByLevel = new Map<string, number>();
  for (const row of publishedRows ?? []) {
    const level = row.cefr_level as string;
    publishedByLevel.set(level, (publishedByLevel.get(level) ?? 0) + 1);
  }

  // ── Episodes in pipeline (pending/processing/retry jobs with episode_id) ──
  const { data: pipelineRows } = await supabase
    .from('listening_jobs')
    .select('episode_id, cefr_level')
    .in('job_type', PIPELINE_JOB_TYPES)
    .in('status', ['pending', 'processing', 'retry'])
    .not('episode_id', 'is', null);

  // Count distinct episodes in pipeline per level
  const pipelineEpisodesByLevel = new Map<string, Set<string>>();
  for (const row of pipelineRows ?? []) {
    if (!row.cefr_level || !row.episode_id) continue;
    const level = row.cefr_level as string;
    if (!pipelineEpisodesByLevel.has(level)) pipelineEpisodesByLevel.set(level, new Set());
    pipelineEpisodesByLevel.get(level)!.add(row.episode_id as string);
  }

  // ── Failed pipelines per level ────────────────────────────────────────────
  const { data: failedRows } = await supabase
    .from('listening_jobs')
    .select('cefr_level')
    .eq('status', 'dead_letter')
    .not('cefr_level', 'is', null);

  const failedByLevel = new Map<string, number>();
  for (const row of failedRows ?? []) {
    const level = row.cefr_level as string;
    failedByLevel.set(level, (failedByLevel.get(level) ?? 0) + 1);
  }

  // ── Active users per level ────────────────────────────────────────────────
  // Use learner_skill_profiles or a reasonable proxy
  const windowDays = INVENTORY_CONFIG.ACTIVE_USER_WINDOW_DAYS;
  const windowDate = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: userRows } = await supabase
    .from('user_listening_progress')
    .select('user_id')
    .gte('updated_at', windowDate);

  // We don't have level per user easily here — fall back to 0 for now
  // A more complete implementation would join with learner_skill_profiles
  const activeUsers = new Set((userRows ?? []).map((r: { user_id: string }) => r.user_id));
  const activeUserCount = activeUsers.size;

  // ── Build result ──────────────────────────────────────────────────────────
  const allLevels = new Set([
    ...ALL_CEFR_LEVELS,
    ...publishedByLevel.keys(),
    ...pipelineEpisodesByLevel.keys(),
  ]);

  const results: ListeningInventoryLevelStatus[] = [];

  for (const level of allLevels) {
    const published   = publishedByLevel.get(level) ?? 0;
    const inPipeline  = pipelineEpisodesByLevel.get(level)?.size ?? 0;
    const failed      = failedByLevel.get(level) ?? 0;
    const missing     = Math.max(0, INVENTORY_CONFIG.DESIRED_PER_LEVEL - published - inPipeline);

    let status: ListeningInventoryLevelStatus['status'];
    if (published === 0 && inPipeline === 0) {
      status = 'empty';
    } else if (published < INVENTORY_CONFIG.MINIMUM_PER_LEVEL) {
      status = 'critical';
    } else if (published < INVENTORY_CONFIG.DESIRED_PER_LEVEL) {
      status = 'low';
    } else {
      status = 'healthy';
    }

    results.push({
      cefrLevel:        level,
      activeUserCount,  // simplified: global count, not per-level
      publishedAvailable: published,
      inPipeline,
      failed,
      minimumTarget:    INVENTORY_CONFIG.MINIMUM_PER_LEVEL,
      desiredTarget:    INVENTORY_CONFIG.DESIRED_PER_LEVEL,
      missingCount:     missing,
      status,
    });
  }

  return results.sort((a, b) => {
    // Sort by urgency: empty > critical > low > healthy
    const urgency = { empty: 0, critical: 1, low: 2, healthy: 3 };
    return urgency[a.status] - urgency[b.status];
  });
}
