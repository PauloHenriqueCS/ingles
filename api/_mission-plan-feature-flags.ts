/**
 * SERVER-ONLY: Feature flags for the pedagogical planner.
 *
 * When LEARNING_ENGINE_VERSION=v2 (default), planner is always 'enabled'.
 * When LEARNING_ENGINE_VERSION=v1 (rollback), planner is 'off'.
 * The individual PEDAGOGICAL_PLANNER_V1 env var is only consulted during v1 rollback.
 *
 * Modes:
 *   off      — planner disabled; existing generation unchanged
 *   shadow   — planner runs + persists plan but does NOT change the mission
 *   enabled  — planner contract is used by the generator (Phase 3 full activation)
 */

import { isV2Active } from '../src/lib/engineVersion';

export type PlannerFeatureMode = 'off' | 'shadow' | 'enabled';

export function getPlannerFeatureMode(): PlannerFeatureMode {
  if (isV2Active()) return 'enabled';

  // V1 rollback: read individual override (defaults to 'off')
  const raw = process.env.PEDAGOGICAL_PLANNER_V1;
  if (!raw) return 'off';
  if (raw === 'shadow') return 'shadow';
  if (raw === 'true' || raw === '1' || raw === 'enabled') return 'enabled';
  return 'off';
}

export function isPlannerEnabled(): boolean {
  return getPlannerFeatureMode() !== 'off';
}

export function isPlannerInShadowMode(): boolean {
  return getPlannerFeatureMode() === 'shadow';
}

export function isPlannerFullyActive(): boolean {
  return getPlannerFeatureMode() === 'enabled';
}
