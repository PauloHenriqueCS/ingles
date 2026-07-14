/**
 * SERVER-ONLY: Feature flags for the mission generator integration.
 *
 * PEDAGOGICAL_GENERATOR_INTEGRATION_V1 controls whether the pedagogical plan
 * is injected into the generation prompt and whether output is validated.
 *
 * Modes:
 *   off      — generator uses existing prompts unchanged; plan not injected
 *   shadow   — plan is built + persisted but NOT injected into prompt
 *   enabled  — plan constraints injected into prompt; output validated
 *
 * MISSION_VALIDATOR_V1 controls how strictly the output validator enforces the plan.
 *
 * Modes:
 *   off      — validator not run
 *   warn     — validator runs and logs; does not reject missions
 *   enforce  — validator runs and rejects missions that fail; triggers retry/fallback
 */

export type GeneratorIntegrationMode = 'off' | 'shadow' | 'enabled';

export function getGeneratorIntegrationMode(): GeneratorIntegrationMode {
  const raw = process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1;
  if (!raw) return 'off';
  if (raw === 'shadow') return 'shadow';
  if (raw === 'true' || raw === '1' || raw === 'enabled') return 'enabled';
  return 'off';
}

export function isGeneratorIntegrationEnabled(): boolean {
  return getGeneratorIntegrationMode() !== 'off';
}

export function isGeneratorIntegrationInShadowMode(): boolean {
  return getGeneratorIntegrationMode() === 'shadow';
}

export function isGeneratorIntegrationFullyActive(): boolean {
  return getGeneratorIntegrationMode() === 'enabled';
}

export type MissionValidatorMode = 'off' | 'warn' | 'enforce';

export function getMissionValidatorMode(): MissionValidatorMode {
  const raw = process.env.MISSION_VALIDATOR_V1;
  if (!raw) return 'off';
  if (raw === 'warn') return 'warn';
  if (raw === 'true' || raw === '1' || raw === 'enforce') return 'enforce';
  return 'off';
}

export function isMissionValidatorActive(): boolean {
  return getMissionValidatorMode() !== 'off';
}

export function isMissionValidatorEnforcing(): boolean {
  return getMissionValidatorMode() === 'enforce';
}
