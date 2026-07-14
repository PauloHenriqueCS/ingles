/**
 * SERVER-ONLY: Feature flags for the pedagogical planner.
 *
 * PEDAGOGICAL_PLANNER_V1 controls shadow-mode vs. full activation.
 *
 * Modes:
 *   off      — planner disabled; existing generation unchanged
 *   shadow   — planner runs + persists plan but does NOT change the mission
 *   enabled  — planner contract is used by the generator (Phase 3 full activation)
 */

export type PlannerFeatureMode = 'off' | 'shadow' | 'enabled';

export function getPlannerFeatureMode(): PlannerFeatureMode {
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
