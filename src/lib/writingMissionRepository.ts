import type { SupabaseClient } from '@supabase/supabase-js';
import type { WritingMission, WritingMissionMode } from '../domain/missions/mission-types';
import type { MissionStatus } from '../domain/missions/mission-status';

export interface CreateWritingMissionInput {
  userId: string;
  skill: string;
  mode: WritingMissionMode;
  title: string;
  promptPtBR: string;
  level: string;
  difficulty: string;
  suggestedWords?: string[];
  supportSentences?: string[];
  pedagogicalPlanId?: string;
  legacyThemeId?: string;
  internalSnapshot?: Record<string, unknown>;
}

export interface UpdateMissionStatusInput {
  missionId: string;
  status: MissionStatus;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  skippedAt?: string;
  expiredAt?: string;
  cancelledAt?: string;
}

function rowToMission(row: Record<string, unknown>): WritingMission {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    skill: row.skill as string,
    status: row.status as MissionStatus,
    mode: row.mode as WritingMissionMode,
    title: row.title as string,
    promptPtBR: row.prompt_pt_br as string,
    level: row.level as string,
    difficulty: row.difficulty as string,
    suggestedWords: row.suggested_words as string[] | undefined,
    supportSentences: row.support_sentences as string[] | undefined,
    pedagogicalPlanId: row.pedagogical_plan_id as string | undefined,
    legacyThemeId: row.legacy_theme_id as string | undefined,
    generatedAt: row.generated_at as string,
    acceptedAt: row.accepted_at as string | undefined,
    startedAt: row.started_at as string | undefined,
    completedAt: row.completed_at as string | undefined,
    skippedAt: row.skipped_at as string | undefined,
    expiredAt: row.expired_at as string | undefined,
    cancelledAt: row.cancelled_at as string | undefined,
    internalSnapshot: row.internal_snapshot as WritingMission['internalSnapshot'],
  };
}

export async function createWritingMission(
  supabase: SupabaseClient,
  input: CreateWritingMissionInput,
): Promise<WritingMission> {
  const { data, error } = await supabase
    .from('writing_missions')
    .insert({
      user_id: input.userId,
      skill: input.skill,
      mode: input.mode,
      status: 'generated',
      title: input.title,
      prompt_pt_br: input.promptPtBR,
      level: input.level,
      difficulty: input.difficulty,
      suggested_words: input.suggestedWords,
      support_sentences: input.supportSentences,
      pedagogical_plan_id: input.pedagogicalPlanId,
      legacy_theme_id: input.legacyThemeId,
      internal_snapshot: input.internalSnapshot,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create writing mission: ${error.message}`);
  return rowToMission(data as Record<string, unknown>);
}

export async function getMissionById(
  supabase: SupabaseClient,
  missionId: string,
): Promise<WritingMission | null> {
  const { data, error } = await supabase
    .from('writing_missions')
    .select('*')
    .eq('id', missionId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get mission: ${error.message}`);
  }
  return rowToMission(data as Record<string, unknown>);
}

export async function getActiveMissionForUser(
  supabase: SupabaseClient,
  userId: string,
  skill: string,
): Promise<WritingMission | null> {
  const { data, error } = await supabase
    .from('writing_missions')
    .select('*')
    .eq('user_id', userId)
    .eq('skill', skill)
    .in('status', ['accepted', 'started'])
    .order('accepted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get active mission: ${error.message}`);
  if (!data) return null;
  return rowToMission(data as Record<string, unknown>);
}

export async function getGeneratedMissionForUser(
  supabase: SupabaseClient,
  userId: string,
  skill: string,
): Promise<WritingMission | null> {
  const { data, error } = await supabase
    .from('writing_missions')
    .select('*')
    .eq('user_id', userId)
    .eq('skill', skill)
    .eq('status', 'generated')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get generated mission: ${error.message}`);
  if (!data) return null;
  return rowToMission(data as Record<string, unknown>);
}

export async function updateMissionStatus(
  supabase: SupabaseClient,
  input: UpdateMissionStatusInput,
): Promise<WritingMission> {
  const update: Record<string, unknown> = { status: input.status };
  if (input.acceptedAt !== undefined) update.accepted_at = input.acceptedAt;
  if (input.startedAt !== undefined) update.started_at = input.startedAt;
  if (input.completedAt !== undefined) update.completed_at = input.completedAt;
  if (input.skippedAt !== undefined) update.skipped_at = input.skippedAt;
  if (input.expiredAt !== undefined) update.expired_at = input.expiredAt;
  if (input.cancelledAt !== undefined) update.cancelled_at = input.cancelledAt;

  const { data, error } = await supabase
    .from('writing_missions')
    .update(update)
    .eq('id', input.missionId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update mission status: ${error.message}`);
  return rowToMission(data as Record<string, unknown>);
}
