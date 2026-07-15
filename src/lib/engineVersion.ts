/**
 * SERVER-ONLY: Central learning engine version configuration.
 * Never import in React components or client-side bundles.
 *
 * Usage:
 *   LEARNING_ENGINE_VERSION=v2  (default — V2 active for all users)
 *   LEARNING_ENGINE_VERSION=v1  (emergency rollback — reverts all engines to off)
 *
 * The frontend never reads this flag. All routing happens server-side in API
 * handlers, which defer to the individual feature-flag modules — each of which
 * delegates here first before reading its own env var.
 */

export type LearningEngineVersion = 'v1' | 'v2';

/**
 * Returns the active learning engine version.
 * Default is 'v2' — no env var required for production activation.
 */
export function getActiveLearningEngineVersion(): LearningEngineVersion {
  if (process.env.LEARNING_ENGINE_VERSION === 'v1') return 'v1';
  return 'v2';
}

/** True when V2 is the active engine (normal production state). */
export function isV2Active(): boolean {
  return getActiveLearningEngineVersion() === 'v2';
}

/** True when V1 rollback is in effect. */
export function isV1Rollback(): boolean {
  return getActiveLearningEngineVersion() === 'v1';
}
