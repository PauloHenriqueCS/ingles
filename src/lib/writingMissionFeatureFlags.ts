/**
 * SERVER-ONLY: feature flags for canonical writing mission state.
 * Never import in React components or client-side bundles.
 *
 * When LEARNING_ENGINE_VERSION=v2 (default), this engine is always 'enabled'.
 * When LEARNING_ENGINE_VERSION=v1 (rollback), falls back to 'off'.
 */

import { isV2Active } from './engineVersion';

export type CanonicalMissionStateMode = 'off' | 'shadow' | 'enabled';

export function getCanonicalMissionStateMode(): CanonicalMissionStateMode {
  if (isV2Active()) return 'enabled';

  // V1 rollback: read individual override (defaults to 'off')
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
