import type { SupabaseClient } from '@supabase/supabase-js';
import type { WritingMission } from '../domain/missions/mission-types';
import {
  getActiveMissionForUser,
  getGeneratedMissionForUser,
} from './writingMissionRepository';

export interface CurrentMissionResult {
  active: WritingMission | null;
  generated: WritingMission | null;
}

/**
 * Returns the current mission state for a user+skill pair.
 * - active: an accepted or started mission (at most one, enforced by DB unique index)
 * - generated: the most recent unaccepted generated mission (may coexist with active)
 */
export async function getCurrentWritingMission(
  supabase: SupabaseClient,
  userId: string,
  skill: string,
): Promise<CurrentMissionResult> {
  const [active, generated] = await Promise.all([
    getActiveMissionForUser(supabase, userId, skill),
    getGeneratedMissionForUser(supabase, userId, skill),
  ]);

  return { active, generated };
}
