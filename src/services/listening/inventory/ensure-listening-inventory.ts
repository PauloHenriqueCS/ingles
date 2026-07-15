import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningPipelineSource } from '../jobs/listening-job-types';
import { INVENTORY_CONFIG } from '../jobs/listening-job-config';
import { getListeningInventoryStatus } from './get-listening-inventory-status';
import { enqueueListeningEpisodePipeline } from '../pipeline/enqueue-listening-episode-pipeline';
import { selectListeningGenerationTheme } from './select-listening-generation-theme';

export type EnsureListeningInventoryOptions = {
  targetLevel?: CEFRLevel;
  source?:      ListeningPipelineSource;
};

export type EnsureListeningInventoryResult = {
  created: number;
  levels:  string[];
};

export async function ensureListeningInventory(
  supabase: SupabaseClient,
  options: EnsureListeningInventoryOptions = {},
): Promise<EnsureListeningInventoryResult> {
  const { targetLevel, source = 'inventory_cron' } = options;

  console.error(JSON.stringify({
    event:       'listening_inventory_checked',
    targetLevel: targetLevel ?? 'all',
    source,
    t: Date.now(),
  }));

  const inventoryStatus = await getListeningInventoryStatus(supabase);

  // Filter to specific level if requested
  const relevantLevels = targetLevel
    ? inventoryStatus.filter(s => s.cefrLevel === targetLevel)
    : inventoryStatus;

  // Sort by urgency: empty first, then critical, then low
  // Within same urgency: more active users first (proxy: fewer published episodes = higher need)
  const needsGeneration = relevantLevels.filter(s => s.missingCount > 0);

  if (needsGeneration.length === 0) {
    console.error(JSON.stringify({ event: 'listening_inventory_healthy', t: Date.now() }));
    return { created: 0, levels: [] };
  }

  let totalCreated = 0;
  const affectedLevels: string[] = [];
  let remainingBudget = INVENTORY_CONFIG.MAX_NEW_PIPELINES_PER_DAY;

  for (const levelStatus of needsGeneration) {
    if (remainingBudget <= 0) break;

    const level = levelStatus.cefrLevel as CEFRLevel;
    const toCreate = Math.min(levelStatus.missingCount, remainingBudget);

    for (let i = 0; i < toCreate; i++) {
      if (remainingBudget <= 0) break;

      try {
        const theme = await selectListeningGenerationTheme(supabase, level);
        const seed  = `${new Date().toISOString().slice(0, 10)}-${i}`;

        const result = await enqueueListeningEpisodePipeline(supabase, {
          cefrLevel: level,
          theme:     theme ?? null,
          seed,
          source,
        });

        if (result.created) {
          totalCreated++;
          remainingBudget--;

          if (!affectedLevels.includes(level)) affectedLevels.push(level);

          console.error(JSON.stringify({
            event:          'listening_inventory_job_created',
            cefrLevel:      level,
            theme:          theme ?? null,
            seed,
            jobId:          result.jobId,
            idempotencyKey: result.idempotencyKey,
            t: Date.now(),
          }));
        }
      } catch (err) {
        console.error(JSON.stringify({
          event:     'listening_inventory_enqueue_error',
          cefrLevel: level,
          error:     String(err),
          t: Date.now(),
        }));
      }
    }
  }

  return { created: totalCreated, levels: affectedLevels };
}
