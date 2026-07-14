/**
 * SERVER-ONLY: feature flags for the vocabulary item review engine.
 * Never import in React components or client-side bundles.
 */

export type VocabularyEngineMode = 'off' | 'shadow' | 'admin' | 'new_users' | 'full';

const VALID_MODES: VocabularyEngineMode[] = ['off', 'shadow', 'admin', 'new_users', 'full'];

export function getVocabularyEngineMode(): VocabularyEngineMode {
  const raw = process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1;
  if (raw && (VALID_MODES as string[]).includes(raw)) {
    return raw as VocabularyEngineMode;
  }
  return 'off';
}

export function isVocabularyEngineEnabled(): boolean {
  return getVocabularyEngineMode() !== 'off';
}

export function isVocabularyEngineShadow(): boolean {
  return getVocabularyEngineMode() === 'shadow';
}

export function isVocabularyEngineFullyActive(): boolean {
  const mode = getVocabularyEngineMode();
  return mode === 'admin' || mode === 'new_users' || mode === 'full';
}
