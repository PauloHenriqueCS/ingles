export type MissionStatus =
  | 'generated'
  | 'accepted'
  | 'started'
  | 'completed'
  | 'skipped'
  | 'superseded'
  | 'expired'
  | 'cancelled';

export const ALL_MISSION_STATUSES: readonly MissionStatus[] = [
  'generated',
  'accepted',
  'started',
  'completed',
  'skipped',
  'superseded',
  'expired',
  'cancelled',
] as const;

export const ACTIVE_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'accepted',
  'started',
]);

export const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'completed',
  'skipped',
  'superseded',
  'expired',
  'cancelled',
]);

export const CONTENT_IMMUTABLE_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'accepted',
  'started',
  'completed',
  'skipped',
  'cancelled',
]);

export function isMissionActive(status: MissionStatus): boolean {
  return ACTIVE_MISSION_STATUSES.has(status);
}

export function isMissionTerminal(status: MissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.has(status);
}

/** Returns true when mission content must be treated as immutable (accepted or beyond). */
export function isContentImmutable(status: MissionStatus): boolean {
  return CONTENT_IMMUTABLE_STATUSES.has(status);
}

/** Only generated missions can be superseded by "Gerar outro tema". */
export function canBeSuperseded(status: MissionStatus): boolean {
  return status === 'generated';
}
