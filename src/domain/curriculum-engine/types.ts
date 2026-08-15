/**
 * Generic, language-agnostic domain types for the data-driven curriculum engine.
 *
 * NOTHING here knows about English, CEFR level names, grammar topics, or any
 * pedagogical content — those are DATA, loaded from the database. These types
 * mirror the tables created in
 * supabase/migrations/20260815120000_curriculum_data_driven_foundation.sql.
 *
 * The two languages are first-class and distinct:
 *   - learningLanguage  — the language the user is LEARNING (en, es, fr, ...)
 *   - interfaceLanguage — the language of UI / instructions / explanations
 * Neither is assumed to be a fixed value anywhere in the engine.
 */

export interface LanguageRef {
  code: string;
  englishName: string;
  nativeName: string;
}

export interface FrameworkLevel {
  frameworkId: string;
  code: string;
  sortOrder: number;
}

export interface CurriculumRef {
  id: string;
  slug: string;
  learningLanguage: string;
  frameworkId: string;
}

export type PublishStatus = 'draft' | 'published' | 'archived';

export interface CurriculumVersionRef {
  id: string;
  curriculumId: string;
  version: number;
  status: PublishStatus;
}

export interface CurriculumModule {
  id: string;
  moduleKey: string;
  levelCode: string;
  sortOrder: number;
  /** Localized (interface language) — safe to show to the user. */
  title: string;
  capability: string | null;
}

export interface LanguageTarget {
  kind: string;
  sortOrder: number;
  text: string;
}

/**
 * A "recorte" — an internal curriculum subtopic. INTERNAL: never rendered as an
 * ID in the UI. Drives generation and progression.
 */
export interface CurriculumSubtopic {
  id: string;
  moduleId: string;
  subtopicKey: string;
  levelCode: string;
  sortOrder: number;
  /** Localized capability (interface language). */
  capability: string;
  languageTargets: LanguageTarget[];
}

export interface TransversalTopic {
  topicKey: string;
  minLevelCode: string | null;
  sortOrder: number;
  label: string;
  description: string | null;
}

export interface PromptTemplate {
  templateKey: string;
  learningLanguage: string;
  interfaceLanguage: string;
  version: number;
  model: string | null;
  temperature: number | null;
  systemBody: string;
  userBody: string | null;
  requiredPlaceholders: string[];
}

export interface LevelGenerationRule {
  levelCode: string;
  activityType: string;
  ruleValue: Record<string, unknown>;
}
