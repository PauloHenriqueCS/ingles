import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import { DAILY_LISTENING_CONFIG } from './listening-daily-config';

export async function resolveUserListeningLevel(
  supabase: SupabaseClient,
  userId: string,
): Promise<CEFRLevel> {
  const { data: profiles } = await supabase
    .from('learner_skill_profiles')
    .select('skill, level')
    .eq('user_id', userId)
    .in('skill', ['listening', 'writing'])
    .not('level', 'is', null);

  if (!profiles) return DAILY_LISTENING_CONFIG.FALLBACK_CEFR_LEVEL;

  const listening = profiles.find((p: any) => p.skill === 'listening');
  if (listening?.level) return listening.level as CEFRLevel;

  const writing = profiles.find((p: any) => p.skill === 'writing');
  if (writing?.level) return writing.level as CEFRLevel;

  return DAILY_LISTENING_CONFIG.FALLBACK_CEFR_LEVEL;
}
