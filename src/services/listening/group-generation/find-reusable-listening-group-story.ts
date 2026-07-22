import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningLevelGroup } from '../listening-level-group';

export type ReusableListeningGroupStory = {
  episodeId: string;
};

/**
 * Looks up an already-published shared story for this exact
 * (level_group, target_level) pair. Content is only ever regenerated when
 * this returns null — this is the "reuse before generate" check that keeps
 * generation on-demand instead of preventive.
 *
 * Filters on both level_group and cefr_level: cefr_level alone already
 * determines level_group (it is a generated column), but the level_group
 * predicate keeps this query explicit about which shard it is reusing from
 * and lets the (level_group, cefr_level, status) index serve it directly.
 */
export async function findReusableListeningGroupStory(
  supabase: SupabaseClient,
  levelGroup: ListeningLevelGroup,
  targetLevel: CEFRLevel,
): Promise<ReusableListeningGroupStory | null> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .select('id')
    .eq('level_group', levelGroup)
    .eq('cefr_level', targetLevel)
    .eq('status', 'published')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up reusable listening group story: ${error.message}`);
  }

  return data ? { episodeId: (data as { id: string }).id } : null;
}
