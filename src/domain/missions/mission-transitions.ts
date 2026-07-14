import type { MissionStatus } from './mission-status';
import { TERMINAL_MISSION_STATUSES } from './mission-status';
import type { MissionTransitionReasonCode } from './mission-transition-reasons';

export interface TransitionCheckInput {
  from: MissionStatus;
  to: MissionStatus;
  reason?: MissionTransitionReasonCode;
}

export interface TransitionCheckResult {
  allowed: boolean;
  rejectionReason?: string;
}

// Self-transitions for accepted and started are idempotent (allowed).
const VALID_TRANSITIONS: ReadonlyMap<MissionStatus, ReadonlySet<MissionStatus>> = new Map([
  ['generated', new Set<MissionStatus>(['accepted', 'superseded', 'expired', 'cancelled'])],
  ['accepted', new Set<MissionStatus>(['accepted', 'started', 'skipped', 'cancelled'])],
  ['started', new Set<MissionStatus>(['started', 'completed', 'skipped', 'cancelled'])],
  ['completed', new Set<MissionStatus>()],
  ['skipped', new Set<MissionStatus>()],
  ['superseded', new Set<MissionStatus>()],
  ['expired', new Set<MissionStatus>()],
  ['cancelled', new Set<MissionStatus>()],
]);

export function canTransitionMissionStatus(input: TransitionCheckInput): TransitionCheckResult {
  const { from, to } = input;
  const validTargets = VALID_TRANSITIONS.get(from);

  if (!validTargets) {
    return { allowed: false, rejectionReason: `Unknown source status: ${from}` };
  }

  if (!validTargets.has(to)) {
    return {
      allowed: false,
      rejectionReason: `Transition from '${from}' to '${to}' is not allowed`,
    };
  }

  return { allowed: true };
}

export function getValidTransitionsFrom(status: MissionStatus): readonly MissionStatus[] {
  return Array.from(VALID_TRANSITIONS.get(status) ?? new Set<MissionStatus>());
}

export function isTerminalStatus(status: MissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.has(status);
}
