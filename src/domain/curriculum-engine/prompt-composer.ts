/**
 * Prompt composer — the generic assembler.
 *
 *   template (per learning+interface language)
 *   + language config
 *   + level rule
 *   + module
 *   + subtopic (recorte)
 *   + language targets
 *   + user context
 *   = final prompt
 *
 * This is the ONLY place a runtime prompt is built for curriculum activities, and
 * it contains ZERO pedagogical content — everything comes from the data passed
 * in. It never falls back to a hardcoded English prompt: a missing template or a
 * missing required placeholder throws (see template-engine).
 */

import type {
  CurriculumModule,
  CurriculumSubtopic,
  LevelGenerationRule,
  PromptTemplate,
} from './types';
import type { LanguageContext } from './language-context';
import { renderTemplate, validateTemplateRequires, TemplateValidationError } from './template-engine';

export interface ComposeInput {
  template: PromptTemplate;
  languageContext: LanguageContext;
  module?: CurriculumModule | null;
  subtopic?: CurriculumSubtopic | null;
  levelRule?: LevelGenerationRule | null;
  /** Transversal targets (e.g. current "needs attention" topics) as free text. */
  transversalTargets?: string[];
  /** Extra caller-supplied values (user context). Merged last; wins on conflict. */
  userContext?: Record<string, string | number>;
}

export interface ComposedPrompt {
  system: string;
  user: string | null;
  model: string | null;
  temperature: number | null;
  /**
   * The version of the prompt_template this prompt was composed from. Surfaced so
   * a shared content library can key compatibility on the generator/prompt
   * version (a template edit under a fixed curriculum version must not silently
   * reuse content produced by the previous prompt). Never pedagogical.
   */
  templateVersion: number;
}

function flattenRuleValues(rule: LevelGenerationRule | null | undefined, interfaceLanguage: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rule) return out;
  for (const [key, value] of Object.entries(rule.ruleValue ?? {})) {
    if (value == null) continue;
    if (typeof value === 'object') {
      // Localized field, e.g. { "pt-BR": "...", "en": "..." } — pick by interface language.
      const record = value as Record<string, unknown>;
      const localized = record[interfaceLanguage];
      if (typeof localized === 'string') out[`rule.${key}`] = localized;
      else out[`rule.${key}`] = JSON.stringify(value);
    } else {
      out[`rule.${key}`] = String(value);
    }
  }
  return out;
}

/**
 * Builds the value map that fills template placeholders. Keys are stable and
 * language-neutral (learning_language, level, module_title, subtopic_capability,
 * language_targets, rule.*, plus any userContext keys).
 */
export function buildTemplateValues(input: ComposeInput): Record<string, string> {
  const { template, languageContext, module, subtopic, levelRule } = input;

  const languageTargets = (subtopic?.languageTargets ?? [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => t.text);

  const values: Record<string, string> = {
    learning_language: languageContext.learningLanguage,
    interface_language: languageContext.interfaceLanguage,
    level: subtopic?.levelCode ?? module?.levelCode ?? '',
    module_key: module?.moduleKey ?? '',
    module_title: module?.title ?? '',
    module_capability: module?.capability ?? '',
    subtopic_key: subtopic?.subtopicKey ?? '',
    subtopic_capability: subtopic?.capability ?? '',
    language_targets: languageTargets.join(', '),
    transversal_targets: (input.transversalTargets ?? []).join(', '),
    ...flattenRuleValues(levelRule, languageContext.interfaceLanguage),
  };

  if (input.userContext) {
    for (const [k, v] of Object.entries(input.userContext)) {
      values[k] = String(v);
    }
  }

  // Template metadata for observability/debugging (never pedagogical).
  values['template_key'] = template.templateKey;

  return values;
}

/**
 * Composes the final prompt. Throws MissingPlaceholderError if the template
 * references a placeholder that the assembled values do not cover (explicit,
 * observable failure — never a silent English fallback).
 */
export function composePrompt(input: ComposeInput): ComposedPrompt {
  const { template } = input;

  // Guard: the template's declared required placeholders must exist in its body.
  validateTemplateRequires(template.systemBody, template.requiredPlaceholders);

  const values = buildTemplateValues(input);

  // Guard: every declared-required placeholder must resolve to a NON-EMPTY value.
  // A required curricular value that is missing/empty (e.g. an untranslated
  // subtopic capability) is an explicit, observable configuration error — never
  // a silent fallback.
  const emptyRequired = template.requiredPlaceholders.filter((p) => {
    const v = values[p];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (emptyRequired.length > 0) {
    throw new TemplateValidationError(
      `Required curricular values are empty: ${emptyRequired.join(', ')}`,
      emptyRequired,
    );
  }

  const system = renderTemplate(template.systemBody, values);
  const user = template.userBody != null ? renderTemplate(template.userBody, values) : null;

  return {
    system,
    user,
    model: template.model,
    temperature: template.temperature,
    templateVersion: template.version,
  };
}
