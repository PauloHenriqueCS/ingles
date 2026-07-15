import { describe, it, expect, vi, afterEach } from 'vitest';

// We test the module by resetting env and re-importing
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('engineVersion', () => {
  it('defaults to v2 when LEARNING_ENGINE_VERSION is not set', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', '');
    const { getActiveLearningEngineVersion, isV2Active, isV1Rollback } = await import('./engineVersion');
    expect(getActiveLearningEngineVersion()).toBe('v2');
    expect(isV2Active()).toBe(true);
    expect(isV1Rollback()).toBe(false);
  });

  it('activates V2 when LEARNING_ENGINE_VERSION=v2', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v2');
    const { getActiveLearningEngineVersion, isV2Active } = await import('./engineVersion');
    expect(getActiveLearningEngineVersion()).toBe('v2');
    expect(isV2Active()).toBe(true);
  });

  it('activates V1 rollback when LEARNING_ENGINE_VERSION=v1', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v1');
    const { getActiveLearningEngineVersion, isV1Rollback } = await import('./engineVersion');
    expect(getActiveLearningEngineVersion()).toBe('v1');
    expect(isV1Rollback()).toBe(true);
  });

  it('treats unknown values as v2 (safe default)', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'invalid_value');
    const { getActiveLearningEngineVersion, isV2Active } = await import('./engineVersion');
    expect(getActiveLearningEngineVersion()).toBe('v2');
    expect(isV2Active()).toBe(true);
  });
});

describe('grammarEvidenceFeatureFlags with engine version', () => {
  it('returns full when V2 is active (default)', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v2');
    vi.stubEnv('GRAMMAR_EVIDENCE_ENGINE_V1', ''); // individual flag irrelevant
    const { getGrammarEvidenceEngineMode, isGrammarEvidenceEngineFullyActive } =
      await import('./grammarEvidenceFeatureFlags');
    expect(getGrammarEvidenceEngineMode()).toBe('full');
    expect(isGrammarEvidenceEngineFullyActive()).toBe(true);
  });

  it('returns off when V1 rollback and no individual override', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v1');
    vi.stubEnv('GRAMMAR_EVIDENCE_ENGINE_V1', '');
    const { getGrammarEvidenceEngineMode } = await import('./grammarEvidenceFeatureFlags');
    expect(getGrammarEvidenceEngineMode()).toBe('off');
  });

  it('respects individual override during V1 rollback', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v1');
    vi.stubEnv('GRAMMAR_EVIDENCE_ENGINE_V1', 'shadow');
    const { getGrammarEvidenceEngineMode } = await import('./grammarEvidenceFeatureFlags');
    expect(getGrammarEvidenceEngineMode()).toBe('shadow');
  });
});

describe('writingMissionFeatureFlags with engine version', () => {
  it('returns enabled when V2 is active', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v2');
    const { getCanonicalMissionStateMode, isCanonicalMissionStateFullyActive } =
      await import('./writingMissionFeatureFlags');
    expect(getCanonicalMissionStateMode()).toBe('enabled');
    expect(isCanonicalMissionStateFullyActive()).toBe(true);
  });

  it('returns off when V1 rollback', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v1');
    vi.stubEnv('CANONICAL_WRITING_MISSION_STATE_V1', '');
    const { getCanonicalMissionStateMode } = await import('./writingMissionFeatureFlags');
    expect(getCanonicalMissionStateMode()).toBe('off');
  });
});

describe('vocabularyFeatureFlags with engine version', () => {
  it('returns full when V2 is active', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v2');
    const { getVocabularyEngineMode, isVocabularyEngineFullyActive } =
      await import('./vocabularyFeatureFlags');
    expect(getVocabularyEngineMode()).toBe('full');
    expect(isVocabularyEngineFullyActive()).toBe(true);
  });
});

describe('writingRewriteFeatureFlags with engine version', () => {
  it('returns full when V2 is active', async () => {
    vi.stubEnv('LEARNING_ENGINE_VERSION', 'v2');
    const { getRewriteV2Mode, isRewriteV2FullyActive } = await import('./writingRewriteFeatureFlags');
    expect(getRewriteV2Mode()).toBe('full');
    expect(isRewriteV2FullyActive()).toBe(true);
  });
});
