import { describe, it, expect } from 'vitest';
import { resolveCurriculumPrompt } from '../resolve-curriculum-prompt';
import { CurriculumConfigError, type CurriculumRepository } from '../curriculum-repository';
import type { CurriculumModule, CurriculumSubtopic, PromptTemplate } from '../types';

function makeRepo(over: Partial<CurriculumRepository> = {}): CurriculumRepository {
  const base: CurriculumRepository = {
    async getPublishedVersion(lang) {
      return lang === 'en' ? { id: 'v1', curriculumId: 'c1', version: 1, status: 'published' } : null;
    },
    async getVersionById(id) {
      // The resolver now loads the PINNED version by id (blocker 1).
      return id === 'v1' ? { id: 'v1', curriculumId: 'c1', version: 1, status: 'published' } : null;
    },
    async listOrderedSubtopics() {
      return [{ subtopicKey: 'B1.OPINION.AGREE_DISAGREE', moduleKey: 'B1.OPINION', levelCode: 'B1' }];
    },
    async getModuleByKey(_v, key): Promise<CurriculumModule> {
      return { id: 'm1', moduleKey: key, levelCode: 'B1', sortOrder: 3, title: 'Opinião', capability: 'opinar' };
    },
    async getSubtopicByKey(_v, key): Promise<CurriculumSubtopic> {
      return {
        id: 's1', moduleId: 'm1', subtopicKey: key, levelCode: 'B1', sortOrder: 2,
        capability: 'Concordar ou discordar',
        languageTargets: [{ kind: 'support', sortOrder: 0, text: 'agreement / disagreement' }],
      };
    },
    async getLevelRule() {
      return { levelCode: 'B1', activityType: 'writing', ruleValue: { word_count_min: 70 } };
    },
    async getPromptTemplate(key, ll, il): Promise<PromptTemplate> {
      return {
        templateKey: key, learningLanguage: ll, interfaceLanguage: il, version: 1,
        model: null, temperature: 0.8,
        systemBody: 'lang={{learning_language}} level={{level}} cap={{subtopic_capability}} targets={{language_targets}}',
        userBody: null, requiredPlaceholders: ['learning_language', 'level', 'subtopic_capability'],
      };
    },
    async listTransversalTopics() { return []; },
    async listSubtopicIdKeyPairs() { return [{ id: 's1', subtopicKey: 'B1.OPINION.AGREE_DISAGREE' }]; },
  };
  return { ...base, ...over };
}

describe('resolveCurriculumPrompt', () => {
  it('resolves version + template + subtopic and composes', async () => {
    const out = await resolveCurriculumPrompt({
      repository: makeRepo(),
      languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
      templateKey: 'writing.generate_topic',
      activityType: 'writing',
      subtopicKey: 'B1.OPINION.AGREE_DISAGREE',
      versionId: 'v1',
    });
    expect(out.system).toBe('lang=en level=B1 cap=Concordar ou discordar targets=agreement / disagreement');
  });

  it('throws (no silent fallback) when the PINNED version is not found', async () => {
    await expect(
      resolveCurriculumPrompt({
        repository: makeRepo(),
        languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
        templateKey: 'writing.generate_topic',
        activityType: 'writing',
        subtopicKey: null,
        versionId: 'missing-version',
      }),
    ).rejects.toBeInstanceOf(CurriculumConfigError);
  });

  it('throws when the template is missing', async () => {
    await expect(
      resolveCurriculumPrompt({
        repository: makeRepo({ async getPromptTemplate() { return null; } }),
        languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
        templateKey: 'writing.generate_topic',
        activityType: 'writing',
        subtopicKey: null,
        versionId: 'v1',
      }),
    ).rejects.toBeInstanceOf(CurriculumConfigError);
  });
});
