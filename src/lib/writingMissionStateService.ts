import type { SupabaseClient } from '@supabase/supabase-js';
import type { WritingMission } from '../domain/missions/mission-types';
import type { MissionSkipReasonCode } from '../domain/missions/mission-transition-reasons';
import { canTransitionMissionStatus } from '../domain/missions/mission-transitions';
import {
  getMissionById,
  updateMissionStatus,
  getActiveMissionForUser,
} from './writingMissionRepository';
import { recordMissionTransition } from './writingMissionHistory';
import { checkAndRecordIdempotentAction } from './writingMissionIdempotency';

export interface MissionActionResult {
  mission: WritingMission;
  wasIdempotent: boolean;
}

export interface AcceptWritingMissionInput {
  missionId: string;
  userId: string;
  skill: string;
  requestId: string;
}

export interface StartWritingMissionInput {
  missionId: string;
  userId: string;
  requestId: string;
}

export interface CompleteWritingMissionInput {
  missionId: string;
  userId: string;
  requestId: string;
}

export interface SkipWritingMissionInput {
  missionId: string;
  userId: string;
  requestId: string;
  skipReason?: MissionSkipReasonCode;
}

export interface SupersedeWritingMissionInput {
  missionId: string;
  userId: string;
}

async function requireMission(
  supabase: SupabaseClient,
  missionId: string,
  userId: string,
): Promise<WritingMission> {
  const mission = await getMissionById(supabase, missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  if (mission.userId !== userId) throw new Error('Mission does not belong to this user');
  return mission;
}

export async function acceptWritingMission(
  supabase: SupabaseClient,
  input: AcceptWritingMissionInput,
): Promise<MissionActionResult> {
  const mission = await requireMission(supabase, input.missionId, input.userId);

  // Self-transition idempotency: already accepted
  if (mission.status === 'accepted') {
    const idempotency = await checkAndRecordIdempotentAction(
      supabase, input.requestId, input.missionId, 'accept', 'accepted',
    );
    if (idempotency.alreadyProcessed) return { mission, wasIdempotent: true };
    return { mission, wasIdempotent: true };
  }

  const check = canTransitionMissionStatus({ from: mission.status, to: 'accepted' });
  if (!check.allowed) throw new Error(`Cannot accept mission: ${check.rejectionReason}`);

  // Enforce one active mission per user+skill
  const existing = await getActiveMissionForUser(supabase, input.userId, input.skill);
  if (existing && existing.id !== input.missionId) {
    throw new Error(
      `User already has an active mission (${existing.id}) for skill '${input.skill}'`,
    );
  }

  const idempotency = await checkAndRecordIdempotentAction(
    supabase, input.requestId, input.missionId, 'accept', 'accepted',
  );
  if (idempotency.alreadyProcessed) return { mission, wasIdempotent: true };

  const now = new Date().toISOString();
  const updated = await updateMissionStatus(supabase, {
    missionId: input.missionId,
    status: 'accepted',
    acceptedAt: now,
  });

  await recordMissionTransition(supabase, {
    missionId: input.missionId,
    userId: input.userId,
    fromStatus: mission.status,
    toStatus: 'accepted',
    source: 'user_action',
    reason: 'user_accepted',
  });

  return { mission: updated, wasIdempotent: false };
}

export async function startWritingMission(
  supabase: SupabaseClient,
  input: StartWritingMissionInput,
): Promise<MissionActionResult> {
  const mission = await requireMission(supabase, input.missionId, input.userId);

  if (mission.status === 'started') {
    const idempotency = await checkAndRecordIdempotentAction(
      supabase, input.requestId, input.missionId, 'start', 'started',
    );
    if (idempotency.alreadyProcessed) return { mission, wasIdempotent: true };
    return { mission, wasIdempotent: true };
  }

  const check = canTransitionMissionStatus({ from: mission.status, to: 'started' });
  if (!check.allowed) throw new Error(`Cannot start mission: ${check.rejectionReason}`);

  const idempotency = await checkAndRecordIdempotentAction(
    supabase, input.requestId, input.missionId, 'start', 'started',
  );
  if (idempotency.alreadyProcessed) return { mission, wasIdempotent: true };

  const now = new Date().toISOString();
  const updated = await updateMissionStatus(supabase, {
    missionId: input.missionId,
    status: 'started',
    startedAt: mission.startedAt ?? now,
  });

  await recordMissionTransition(supabase, {
    missionId: input.missionId,
    userId: input.userId,
    fromStatus: mission.status,
    toStatus: 'started',
    source: 'user_action',
    reason: 'user_started',
  });

  return { mission: updated, wasIdempotent: false };
}

export async function completeWritingMission(
  supabase: SupabaseClient,
  input: CompleteWritingMissionInput,
): Promise<MissionActionResult> {
  const mission = await requireMission(supabase, input.missionId, input.userId);

  const check = canTransitionMissionStatus({ from: mission.status, to: 'completed' });
  if (!check.allowed) throw new Error(`Cannot complete mission: ${check.rejectionReason}`);

  const idempotency = await checkAndRecordIdempotentAction(
    supabase, input.requestId, input.missionId, 'complete', 'completed',
  );
  if (idempotency.alreadyProcessed) return { mission, wasIdempotent: true };

  const now = new Date().toISOString();
  const updated = await updateMissionStatus(supabase, {
    missionId: input.missionId,
    status: 'completed',
    completedAt: now,
  });

  await recordMissionTransition(supabase, {
    missionId: input.missionId,
    userId: input.userId,
    fromStatus: mission.status,
    toStatus: 'completed',
    source: 'user_action',
    reason: 'user_completed',
  });

  return { mission: updated, wasIdempotent: false };
}

export async function skipWritingMission(
  supabase: SupabaseClient,
  input: SkipWritingMissionInput,
): Promise<MissionActionResult> {
  const mission = await requireMission(supabase, input.missionId, input.userId);

  const check = canTransitionMissionStatus({ from: mission.status, to: 'skipped' });
  if (!check.allowed) throw new Error(`Cannot skip mission: ${check.rejectionReason}`);

  const idempotency = await checkAndRecordIdempotentAction(
    supabase, input.requestId, input.missionId, 'skip', 'skipped',
  );
  if (idempotency.alreadyProcessed) return { mission, wasIdempotent: true };

  const now = new Date().toISOString();
  const updated = await updateMissionStatus(supabase, {
    missionId: input.missionId,
    status: 'skipped',
    skippedAt: now,
  });

  await recordMissionTransition(supabase, {
    missionId: input.missionId,
    userId: input.userId,
    fromStatus: mission.status,
    toStatus: 'skipped',
    source: 'user_action',
    reason: 'user_skipped',
    metadata: input.skipReason ? { skipReason: input.skipReason } : undefined,
  });

  return { mission: updated, wasIdempotent: false };
}

export async function supersedeWritingMission(
  supabase: SupabaseClient,
  input: SupersedeWritingMissionInput,
): Promise<WritingMission> {
  const mission = await requireMission(supabase, input.missionId, input.userId);

  const check = canTransitionMissionStatus({ from: mission.status, to: 'superseded' });
  if (!check.allowed) throw new Error(`Cannot supersede mission: ${check.rejectionReason}`);

  const now = new Date().toISOString();
  const updated = await updateMissionStatus(supabase, {
    missionId: input.missionId,
    status: 'superseded',
    cancelledAt: now,
  });

  await recordMissionTransition(supabase, {
    missionId: input.missionId,
    userId: input.userId,
    fromStatus: mission.status,
    toStatus: 'superseded',
    source: 'user_action',
    reason: 'user_superseded',
  });

  return updated;
}
