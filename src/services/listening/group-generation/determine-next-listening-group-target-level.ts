import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningLevelGroup } from '../listening-level-group';
import { LEVEL_GROUP_MEMBERS, otherLevelInGroup } from '../listening-level-group';

/**
 * Deterministically picks the next individual CEFR level to generate for a
 * shared level_group, alternating between the group's two members (e.g.
 * A1_A2: A1, then A2, then A1, ...).
 *
 * Reads the most recently created listening_generation_jobs row for the
 * group and flips to the other member. With no prior job, starts at the
 * group's first member. Safe under concurrency: job creation itself is
 * serialized by the partial unique index on level_group (see the migration),
 * so at most one caller ever succeeds in inserting a job for a computed
 * target level — a second concurrent caller either loses the insert race and
 * reuses the winner's job, or (if it reads after the winner's job already
 * committed) naturally computes the *next* level instead.
 */
export async function determineNextListeningGroupTargetLevel(
  supabase: SupabaseClient,
  levelGroup: ListeningLevelGroup,
): Promise<CEFRLevel> {
  const { data: lastJob, error } = await supabase
    .from('listening_generation_jobs')
    .select('target_level')
    .eq('level_group', levelGroup)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read last listening group job for alternation: ${error.message}`);
  }

  const [first] = LEVEL_GROUP_MEMBERS[levelGroup];
  if (!lastJob) return first;

  return otherLevelInGroup(levelGroup, lastJob.target_level as CEFRLevel);
}
