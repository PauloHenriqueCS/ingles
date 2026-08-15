/**
 * Curriculum repository — the data-access port and a Supabase implementation.
 *
 * The engine (composer/progression) is pure; this is the ONLY layer that talks
 * to the database. It loads DATA (curriculum, templates, rules, user progress);
 * it contains no pedagogical logic.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CurriculumModule,
  CurriculumSubtopic,
  CurriculumVersionRef,
  LanguageTarget,
  LevelGenerationRule,
  PromptTemplate,
  TransversalTopic,
} from './types';
import type { OrderedSubtopic } from './progression';

export class CurriculumConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumConfigError';
  }
}

export interface CurriculumRepository {
  getPublishedVersion(learningLanguage: string): Promise<CurriculumVersionRef | null>;
  listOrderedSubtopics(versionId: string): Promise<OrderedSubtopic[]>;
  getModuleByKey(versionId: string, moduleKey: string, interfaceLanguage: string): Promise<CurriculumModule | null>;
  getSubtopicByKey(versionId: string, subtopicKey: string, interfaceLanguage: string): Promise<CurriculumSubtopic | null>;
  getLevelRule(versionId: string, levelCode: string, activityType: string): Promise<LevelGenerationRule | null>;
  getPromptTemplate(
    templateKey: string,
    learningLanguage: string,
    interfaceLanguage: string,
  ): Promise<PromptTemplate | null>;
  listTransversalTopics(versionId: string, interfaceLanguage: string): Promise<TransversalTopic[]>;
  /** Maps subtopic id <-> semantic key for a version (both directions). */
  listSubtopicIdKeyPairs(versionId: string): Promise<Array<{ id: string; subtopicKey: string }>>;
  /** All modules of a version with localized title/capability (macro plan view). */
  listModules(versionId: string, interfaceLanguage: string): Promise<CurriculumModule[]>;
}

/* ---------------------------------------------------------------------------
 * Supabase implementation
 * ------------------------------------------------------------------------- */

interface VersionRow { id: string; curriculum_id: string; version: number; status: string; }
interface ModuleRow { id: string; module_key: string; level_code: string; sort_order: number; }
interface ModuleI18nRow { title: string; capability: string | null; }
interface SubtopicRow { id: string; module_id: string; subtopic_key: string; level_code: string; sort_order: number; }
interface SubtopicI18nRow { capability: string | null; }
interface TargetRow { kind: string; sort_order: number; target_text: string; }
interface OrderedRow { subtopic_key: string; level_code: string; sort_order: number; curriculum_modules: { module_key: string; sort_order: number } | null; }
interface RuleRow { level_code: string; activity_type: string; rule_value: Record<string, unknown>; }
interface TemplateRow {
  template_key: string; learning_language: string; interface_language: string; version: number;
  model: string | null; temperature: number | null; system_body: string; user_body: string | null;
  required_placeholders: string[];
}
interface TransversalRow { topic_key: string; min_level_code: string | null; sort_order: number; }
interface TransversalI18nRow { label: string; description: string | null; }

export class SupabaseCurriculumRepository implements CurriculumRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getPublishedVersion(learningLanguage: string): Promise<CurriculumVersionRef | null> {
    const { data, error } = await this.client
      .from('curriculum_versions')
      .select('id, curriculum_id, version, status, curricula!inner(learning_language)')
      .eq('status', 'published')
      .eq('curricula.learning_language', learningLanguage)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new CurriculumConfigError(`getPublishedVersion failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as VersionRow;
    return { id: row.id, curriculumId: row.curriculum_id, version: row.version, status: 'published' };
  }

  async listOrderedSubtopics(versionId: string): Promise<OrderedSubtopic[]> {
    const { data, error } = await this.client
      .from('curriculum_subtopics')
      .select('subtopic_key, level_code, sort_order, curriculum_modules!inner(module_key, sort_order)')
      .eq('curriculum_version_id', versionId);
    if (error) throw new CurriculumConfigError(`listOrderedSubtopics failed: ${error.message}`);
    const rows = (data ?? []) as unknown as OrderedRow[];
    // Ordering is data: level.sortOrder is encoded via level_code order in the
    // framework; here we sort by (module.sort_order, subtopic.sort_order) which
    // is globally monotonic because module_key carries the level prefix and
    // module.sort_order is assigned per level in ascending level order at seed
    // time. To be robust, sort by (level_code, module.sort_order, sort_order).
    return rows
      .map((r) => ({
        subtopicKey: r.subtopic_key,
        moduleKey: r.curriculum_modules?.module_key ?? '',
        levelCode: r.level_code,
        _mo: r.curriculum_modules?.sort_order ?? 0,
        _so: r.sort_order,
      }))
      .sort((a, b) =>
        a.levelCode < b.levelCode ? -1 : a.levelCode > b.levelCode ? 1 : a._mo - b._mo || a._so - b._so,
      )
      .map(({ subtopicKey, moduleKey, levelCode }) => ({ subtopicKey, moduleKey, levelCode }));
  }

  async getModuleByKey(versionId: string, moduleKey: string, interfaceLanguage: string): Promise<CurriculumModule | null> {
    const { data, error } = await this.client
      .from('curriculum_modules')
      .select('id, module_key, level_code, sort_order')
      .eq('curriculum_version_id', versionId)
      .eq('module_key', moduleKey)
      .maybeSingle();
    if (error) throw new CurriculumConfigError(`getModuleByKey failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as ModuleRow;
    const { data: i18n } = await this.client
      .from('curriculum_module_i18n')
      .select('title, capability')
      .eq('module_id', row.id)
      .eq('interface_language', interfaceLanguage)
      .maybeSingle();
    const loc = (i18n ?? null) as unknown as ModuleI18nRow | null;
    return {
      id: row.id,
      moduleKey: row.module_key,
      levelCode: row.level_code,
      sortOrder: row.sort_order,
      title: loc?.title ?? row.module_key,
      capability: loc?.capability ?? null,
    };
  }

  async getSubtopicByKey(versionId: string, subtopicKey: string, interfaceLanguage: string): Promise<CurriculumSubtopic | null> {
    const { data, error } = await this.client
      .from('curriculum_subtopics')
      .select('id, module_id, subtopic_key, level_code, sort_order')
      .eq('curriculum_version_id', versionId)
      .eq('subtopic_key', subtopicKey)
      .maybeSingle();
    if (error) throw new CurriculumConfigError(`getSubtopicByKey failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as SubtopicRow;

    const [{ data: i18n }, { data: targets }] = await Promise.all([
      this.client
        .from('curriculum_subtopic_i18n')
        .select('capability')
        .eq('subtopic_id', row.id)
        .eq('interface_language', interfaceLanguage)
        .maybeSingle(),
      this.client
        .from('curriculum_language_targets')
        .select('kind, sort_order, target_text')
        .eq('subtopic_id', row.id)
        .order('sort_order', { ascending: true }),
    ]);

    const loc = (i18n ?? null) as unknown as SubtopicI18nRow | null;
    const targetRows = (targets ?? []) as unknown as TargetRow[];
    const languageTargets: LanguageTarget[] = targetRows.map((t) => ({
      kind: t.kind,
      sortOrder: t.sort_order,
      text: t.target_text,
    }));

    return {
      id: row.id,
      moduleId: row.module_id,
      subtopicKey: row.subtopic_key,
      levelCode: row.level_code,
      sortOrder: row.sort_order,
      capability: loc?.capability ?? '',
      languageTargets,
    };
  }

  async getLevelRule(versionId: string, levelCode: string, activityType: string): Promise<LevelGenerationRule | null> {
    // Prefer the activity-specific rule, then the wildcard '*'.
    const { data, error } = await this.client
      .from('level_generation_rules')
      .select('level_code, activity_type, rule_value')
      .eq('curriculum_version_id', versionId)
      .eq('level_code', levelCode)
      .in('activity_type', [activityType, '*']);
    if (error) throw new CurriculumConfigError(`getLevelRule failed: ${error.message}`);
    const rows = (data ?? []) as unknown as RuleRow[];
    if (rows.length === 0) return null;
    const chosen = rows.find((r) => r.activity_type === activityType) ?? rows[0];
    return { levelCode: chosen.level_code, activityType: chosen.activity_type, ruleValue: chosen.rule_value ?? {} };
  }

  async getPromptTemplate(
    templateKey: string,
    learningLanguage: string,
    interfaceLanguage: string,
  ): Promise<PromptTemplate | null> {
    const { data, error } = await this.client
      .from('prompt_templates')
      .select('template_key, learning_language, interface_language, version, model, temperature, system_body, user_body, required_placeholders')
      .eq('template_key', templateKey)
      .eq('learning_language', learningLanguage)
      .eq('interface_language', interfaceLanguage)
      .eq('status', 'published')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new CurriculumConfigError(`getPromptTemplate failed: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as TemplateRow;
    return {
      templateKey: row.template_key,
      learningLanguage: row.learning_language,
      interfaceLanguage: row.interface_language,
      version: row.version,
      model: row.model,
      temperature: row.temperature != null ? Number(row.temperature) : null,
      systemBody: row.system_body,
      userBody: row.user_body,
      requiredPlaceholders: row.required_placeholders ?? [],
    };
  }

  async listModules(versionId: string, interfaceLanguage: string): Promise<CurriculumModule[]> {
    const { data, error } = await this.client
      .from('curriculum_modules')
      .select('id, module_key, level_code, sort_order')
      .eq('curriculum_version_id', versionId);
    if (error) throw new CurriculumConfigError(`listModules failed: ${error.message}`);
    const rows = (data ?? []) as unknown as ModuleRow[];
    const out: CurriculumModule[] = [];
    for (const row of rows) {
      const { data: i18n } = await this.client
        .from('curriculum_module_i18n')
        .select('title, capability')
        .eq('module_id', row.id)
        .eq('interface_language', interfaceLanguage)
        .maybeSingle();
      const loc = (i18n ?? null) as unknown as ModuleI18nRow | null;
      out.push({
        id: row.id,
        moduleKey: row.module_key,
        levelCode: row.level_code,
        sortOrder: row.sort_order,
        title: loc?.title ?? row.module_key,
        capability: loc?.capability ?? null,
      });
    }
    return out.sort((a, b) => (a.levelCode < b.levelCode ? -1 : a.levelCode > b.levelCode ? 1 : a.sortOrder - b.sortOrder));
  }

  async listSubtopicIdKeyPairs(versionId: string): Promise<Array<{ id: string; subtopicKey: string }>> {
    const { data, error } = await this.client
      .from('curriculum_subtopics')
      .select('id, subtopic_key')
      .eq('curriculum_version_id', versionId);
    if (error) throw new CurriculumConfigError(`listSubtopicIdKeyPairs failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<{ id: string; subtopic_key: string }>;
    return rows.map((r) => ({ id: r.id, subtopicKey: r.subtopic_key }));
  }

  async listTransversalTopics(versionId: string, interfaceLanguage: string): Promise<TransversalTopic[]> {
    const { data, error } = await this.client
      .from('curriculum_transversal_topics')
      .select('id, topic_key, min_level_code, sort_order')
      .eq('curriculum_version_id', versionId)
      .order('sort_order', { ascending: true });
    if (error) throw new CurriculumConfigError(`listTransversalTopics failed: ${error.message}`);
    const rows = (data ?? []) as unknown as (TransversalRow & { id: string })[];
    const out: TransversalTopic[] = [];
    for (const r of rows) {
      const { data: i18n } = await this.client
        .from('curriculum_transversal_topic_i18n')
        .select('label, description')
        .eq('topic_id', r.id)
        .eq('interface_language', interfaceLanguage)
        .maybeSingle();
      const loc = (i18n ?? null) as unknown as TransversalI18nRow | null;
      out.push({
        topicKey: r.topic_key,
        minLevelCode: r.min_level_code,
        sortOrder: r.sort_order,
        label: loc?.label ?? r.topic_key,
        description: loc?.description ?? null,
      });
    }
    return out;
  }
}
