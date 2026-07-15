/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 *
 * When LEARNING_ENGINE_VERSION=v2 (default), this engine is always 'full'.
 * When LEARNING_ENGINE_VERSION=v1 (rollback), this engine falls back to 'off'.
 * The individual env var GRAMMAR_EVIDENCE_ENGINE_V1 is only consulted during v1 rollback.
 */

import { isV2Active } from './engineVersion';

export type GrammarEvidenceEngineMode = 'off' | 'shadow' | 'admin' | 'new_users' | 'full';

const VALID_MODES: GrammarEvidenceEngineMode[] = ['off', 'shadow', 'admin', 'new_users', 'full'];

export function getGrammarEvidenceEngineMode(): GrammarEvidenceEngineMode {
  if (isV2Active()) return 'full';

  // V1 rollback: read individual override (defaults to 'off')
  const raw = process.env.GRAMMAR_EVIDENCE_ENGINE_V1;
  if (raw && (VALID_MODES as string[]).includes(raw)) {
    return raw as GrammarEvidenceEngineMode;
  }
  return 'off';
}

export function isGrammarEvidenceEngineEnabled(): boolean {
  return getGrammarEvidenceEngineMode() !== 'off';
}

export function isGrammarEvidenceEngineShadow(): boolean {
  return getGrammarEvidenceEngineMode() === 'shadow';
}

export function isGrammarEvidenceEngineFullyActive(): boolean {
  const mode = getGrammarEvidenceEngineMode();
  return mode === 'admin' || mode === 'new_users' || mode === 'full';
}
