export type CanonicalMissionStateMode = 'off' | 'shadow' | 'enabled';

export function getCanonicalMissionStateMode(): CanonicalMissionStateMode {
  const raw = process.env.CANONICAL_WRITING_MISSION_STATE_V1;
  if (raw === 'shadow' || raw === 'enabled') return raw;
  return 'off';
}

export function isCanonicalMissionStateEnabled(): boolean {
  return getCanonicalMissionStateMode() !== 'off';
}

export function isCanonicalMissionStateShadow(): boolean {
  return getCanonicalMissionStateMode() === 'shadow';
}

export function isCanonicalMissionStateFullyActive(): boolean {
  return getCanonicalMissionStateMode() === 'enabled';
}
