/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 */

export type GrammarEvidenceEngineMode = 'off' | 'shadow' | 'admin' | 'new_users' | 'full';

const VALID_MODES: GrammarEvidenceEngineMode[] = ['off', 'shadow', 'admin', 'new_users', 'full'];

export function getGrammarEvidenceEngineMode(): GrammarEvidenceEngineMode {
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
