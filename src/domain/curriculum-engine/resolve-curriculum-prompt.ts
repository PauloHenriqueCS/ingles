/**
 * High-level seam the API endpoints call to obtain a fully-composed, curriculum-
 * aware prompt for a given activity. This is where Writing / Listening /
 * Pronunciation / Conversation endpoints plug in (see docs/curriculum-engine.md
 * for the wiring plan).
 *
 * It performs NO pedagogical decisions of its own — it loads data via the
 * repository and delegates assembly to the pure composer. A misconfiguration
 * (missing published curriculum, missing template, missing required placeholder)
 * throws an explicit, observable error instead of silently falling back to any
 * hardcoded English prompt.
 */

import type { CurriculumRepository } from './curriculum-repository';
import { CurriculumConfigError } from './curriculum-repository';
import type { LanguageContext } from './language-context';
import { composePrompt, type ComposedPrompt } from './prompt-composer';

export interface ResolveCurriculumPromptInput {
  repository: CurriculumRepository;
  languageContext: LanguageContext;
  templateKey: string;
  activityType: string;
  /** The recorte to practise. When null, the caller wants a level-only prompt. */
  subtopicKey: string | null;
  transversalTargets?: string[];
  userContext?: Record<string, string | number>;
}

export async function resolveCurriculumPrompt(input: ResolveCurriculumPromptInput): Promise<ComposedPrompt> {
  const { repository, languageContext, templateKey, activityType, subtopicKey } = input;

  const version = await repository.getPublishedVersion(languageContext.learningLanguage);
  if (!version) {
    throw new CurriculumConfigError(
      `No published curriculum for learning_language="${languageContext.learningLanguage}"`,
    );
  }

  const template = await repository.getPromptTemplate(
    templateKey,
    languageContext.learningLanguage,
    languageContext.interfaceLanguage,
  );
  if (!template) {
    throw new CurriculumConfigError(
      `No published prompt_template "${templateKey}" for (${languageContext.learningLanguage}, ${languageContext.interfaceLanguage})`,
    );
  }

  const subtopic = subtopicKey
    ? await repository.getSubtopicByKey(version.id, subtopicKey, languageContext.interfaceLanguage)
    : null;
  if (subtopicKey && !subtopic) {
    throw new CurriculumConfigError(`Subtopic "${subtopicKey}" not found in version ${version.version}`);
  }

  const module = subtopic
    ? await repository.getModuleByKey(
        version.id,
        subtopic.subtopicKey.split('.').slice(0, 2).join('.'),
        languageContext.interfaceLanguage,
      )
    : null;

  const levelCode = subtopic?.levelCode ?? null;
  const levelRule = levelCode ? await repository.getLevelRule(version.id, levelCode, activityType) : null;

  return composePrompt({
    template,
    languageContext,
    module,
    subtopic,
    levelRule,
    transversalTargets: input.transversalTargets,
    userContext: input.userContext,
  });
}
