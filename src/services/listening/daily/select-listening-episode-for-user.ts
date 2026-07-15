import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';

export async function selectListeningEpisodeForUser(
  supabase: SupabaseClient,
  userId: string,
  cefrLevel: CEFRLevel,
): Promise<string | null> {
  const { data: episodes } = await supabase
    .from('listening_episodes')
    .select('id')
    .eq('status', 'published')
    .eq('cefr_level', cefrLevel)
    .order('created_at', { ascending: true });

  if (!episodes || episodes.length === 0) return null;
  const episodeIds = episodes.map((e: any) => e.id as string);

  const { data: assignments } = await supabase
    .from('user_listening_assignments')
    .select('episode_id, status')
    .eq('user_id', userId)
    .in('episode_id', episodeIds);

  const assignedMap = new Map<string, string>();
  for (const a of assignments ?? []) {
    assignedMap.set(a.episode_id, a.status);
  }

  // Priority 1: never assigned
  const neverAssigned = episodeIds.filter((id: string) => !assignedMap.has(id));
  if (neverAssigned.length > 0) return neverAssigned[0];

  // Priority 2: assigned/in_progress but not yet completed
  const incomplete = episodeIds.filter((id: string) => {
    const s = assignedMap.get(id);
    return s === 'assigned' || s === 'in_progress';
  });
  if (incomplete.length > 0) return incomplete[0];

  // Priority 3: completed (oldest first, rotation)
  return episodeIds[0];
}
