/**
 * SERVER-ONLY HTTP handlers for the curriculum endpoints, folded into the
 * grammar-explanation function via __lemonRoute (Vercel 12-function cap). Routes:
 *   GET  /api/curriculum/tree         → full MACRO plan tree (levels → modules),
 *                                        localized, with per-level band + status.
 *                                        NO recortes / subtopics / counts / ids.
 *   GET  /api/curriculum/plan         → (legacy) macro plan (levels → modules)
 *   GET  /api/curriculum/preferences  → the user's modality selection
 *   PUT  /api/curriculum/preferences  → update modality selection (menu = rule)
 *   GET  /api/curriculum/progress     → current module/level/status (recorte hidden)
 */

import { requireAuth } from '../_auth';
import { methodGuard, readRawBody, jsonError, safeLog } from '../_helpers';
import { getCurriculumServiceClient } from './service-client';
import { ensureUserCurriculum, CurriculumConfigError } from './curriculum-runtime';
import { SupabaseCurriculumRepository } from '../../src/domain/curriculum-engine/curriculum-repository';

type ModuleState = 'completed' | 'current' | 'upcoming';

function moduleKeyOf(subtopicKey: string): string {
  return subtopicKey.split('.').slice(0, 2).join('.');
}

function levelCodeOf(subtopicKey: string): string {
  return subtopicKey.split('.')[0];
}

// ── Proficiency band labels (localized, ONE place) ───────────────────────────
// The schema's proficiency_levels carries only a code + sort_order (no band
// column, no *_i18n table). Rather than change the schema, the band is DERIVED
// from the level's sort_order (pairs of levels → one band) and localized here in
// a single backend map keyed by interface_language. This is the least-intrusive
// correct option offered by the spec ("compute from a small localized map keyed
// by interface_language in ONE backend place, never spread in the frontend").
// Deriving from sort_order (DATA) — never from hardcoded level codes — keeps it
// framework-agnostic: any 6-level scale groups 1-2 / 3-4 / 5-6.
const BAND_LABELS: Record<string, string[]> = {
  'pt-BR': ['Iniciante', 'Intermediário', 'Avançado'],
  en: ['Beginner', 'Intermediate', 'Advanced'],
};

export function proficiencyBandLabel(sortOrder: number, interfaceLanguage: string): string {
  const bands = BAND_LABELS[interfaceLanguage] ?? BAND_LABELS['pt-BR'];
  const idx = Math.min(Math.max(0, Math.floor((sortOrder - 1) / 2)), bands.length - 1);
  return bands[idx];
}

// ── Pure macro-tree assembly (unit-tested; no DB / no I/O) ────────────────────

export type CurriculumTreeStatus = 'active' | 'curriculum_completed';
export type CurriculumNodeStatus = 'completed' | 'current' | 'future';

export interface TreeLevelInput {
  code: string;
  sortOrder: number;
  /** Localized display label from proficiency_levels (falls back to code). */
  label: string | null;
}

export interface TreeModuleInput {
  moduleKey: string;
  levelCode: string;
  /** Localized (interface language) module title. */
  title: string;
  sortOrder: number;
}

export interface AssembleCurriculumTreeInput {
  interfaceLanguage: string;
  status: CurriculumTreeStatus;
  /** ALL framework levels (e.g. A1..C2), any order — sorted here. */
  levels: TreeLevelInput[];
  /** ALL modules of the version (localized title), any order — sorted here. */
  modules: TreeModuleInput[];
  /** subtopic (recorte) keys per moduleKey — used ONLY to derive counts→status. */
  subtopicKeysByModule: Map<string, string[]>;
  /** Set of completed subtopic keys for the user. */
  completedSubtopicKeys: Set<string>;
  /** The user's current recorte key, or null when curriculum_completed. */
  currentSubtopicKey: string | null;
}

export interface CurriculumTreeModuleNode {
  /** Opaque, stable module id — safe to show; carries no recorte data. */
  moduleKey: string;
  title: string;
  status: CurriculumNodeStatus;
}

export interface CurriculumTreeLevelNode {
  levelCode: string;
  /** Localized level name (display label). */
  name: string;
  /** Localized band label (Iniciante / Intermediário / Avançado). */
  band: string;
  status: CurriculumNodeStatus;
  modules: CurriculumTreeModuleNode[];
}

export interface CurriculumTreeResult {
  status: CurriculumTreeStatus;
  /** The level the user is on (C2 when the curriculum is completed). */
  currentLevelCode: string | null;
  levels: CurriculumTreeLevelNode[];
}

/**
 * Derives the full A1..C2 macro tree with per-level + per-module status.
 * READ-ONLY and pure: no subtopic/recorte keys, no counts, no technical ids,
 * and no ordering of recortes ever leaves this function — only display fields.
 *
 *   completed → curriculum finished: EVERY level shown completed, no reset,
 *               currentLevelCode = last level (C2).
 *   active    → current level = the level of the current recorte; earlier
 *               levels completed, later levels future. Within the current level
 *               the module holding the current recorte is 'current', earlier
 *               modules 'completed', later 'future'.
 */
export function assembleCurriculumTree(input: AssembleCurriculumTreeInput): CurriculumTreeResult {
  const levels = [...input.levels].sort((a, b) => a.sortOrder - b.sortOrder);
  const isCompleted = input.status === 'curriculum_completed';

  const currentLevelCode = isCompleted
    ? (levels.length > 0 ? levels[levels.length - 1].code : null)
    : (input.currentSubtopicKey ? levelCodeOf(input.currentSubtopicKey) : null);
  const currentModuleKey =
    !isCompleted && input.currentSubtopicKey ? moduleKeyOf(input.currentSubtopicKey) : null;

  const currentLevelSort = levels.find((l) => l.code === currentLevelCode)?.sortOrder ?? null;

  const levelNodes: CurriculumTreeLevelNode[] = levels.map((lvl) => {
    let levelStatus: CurriculumNodeStatus;
    if (isCompleted) {
      levelStatus = 'completed';
    } else if (lvl.code === currentLevelCode) {
      levelStatus = 'current';
    } else if (currentLevelSort !== null && lvl.sortOrder < currentLevelSort) {
      levelStatus = 'completed';
    } else {
      levelStatus = 'future';
    }

    const modules = input.modules
      .filter((m) => m.levelCode === lvl.code)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((m): CurriculumTreeModuleNode => {
        const subs = input.subtopicKeysByModule.get(m.moduleKey) ?? [];
        const total = subs.length;
        const done = subs.filter((k) => input.completedSubtopicKeys.has(k)).length;
        let status: CurriculumNodeStatus;
        if (total > 0 && done === total) status = 'completed';
        else if (!isCompleted && m.moduleKey === currentModuleKey) status = 'current';
        else status = 'future';
        return { moduleKey: m.moduleKey, title: m.title, status };
      });

    return {
      levelCode: lvl.code,
      name: lvl.label ?? lvl.code,
      band: proficiencyBandLabel(lvl.sortOrder, input.interfaceLanguage),
      status: levelStatus,
      modules,
    };
  });

  return { status: input.status, currentLevelCode, levels: levelNodes };
}

export async function handleCurriculumRoute(req: any, res: any, action: string): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const service = getCurriculumServiceClient();

  try {
    if (action === 'tree') {
      if (!methodGuard(req, res, ['GET'])) return;
      return await handleTree(res, userId, service);
    }
    if (action === 'plan') {
      if (!methodGuard(req, res, ['GET'])) return;
      return await handlePlan(res, userId, service);
    }
    if (action === 'preferences') {
      if (req.method === 'GET') return await handleGetPreferences(res, userId, service);
      if (req.method === 'PUT') return await handlePutPreferences(req, res, userId, service);
      res.setHeader('Allow', 'GET, PUT');
      return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
    }
    if (action === 'progress') {
      if (!methodGuard(req, res, ['GET'])) return;
      return await handleProgress(res, userId, service);
    }
    return jsonError(res, 404, 'NOT_FOUND', 'Rota de currículo desconhecida.');
  } catch (err) {
    if (err instanceof CurriculumConfigError) {
      safeLog('curriculum', 'config_error', 503, { action });
      return jsonError(res, 503, 'CURRICULUM_NOT_CONFIGURED', 'Currículo indisponível no momento.');
    }
    safeLog('curriculum', 'error', 500, { action });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

async function completedKeySet(service: any, userId: string, idToKey: Map<string, string>): Promise<Set<string>> {
  const { data } = await service.from('user_subtopic_completion').select('subtopic_id').eq('user_id', userId);
  const rows = (data ?? []) as Array<{ subtopic_id: string }>;
  return new Set(rows.map((r) => idToKey.get(r.subtopic_id)).filter((k): k is string => !!k));
}

async function handleTree(res: any, userId: string, service: any): Promise<void> {
  const ensured = await ensureUserCurriculum(service, userId);
  const repo = new SupabaseCurriculumRepository(service);
  const interfaceLanguage = ensured.languageContext.interfaceLanguage;

  // All framework levels (A1..C2) — data-driven from proficiency_levels, so the
  // whole ladder is shown even for levels that currently have no modules.
  const version = await repo.getPublishedVersion(ensured.languageContext.learningLanguage);
  let levelInputs: Array<{ code: string; sortOrder: number; label: string | null }> = [];
  if (version) {
    const { data: curRow } = await service
      .from('curricula')
      .select('framework_id')
      .eq('id', version.curriculumId)
      .maybeSingle();
    const frameworkId = (curRow as { framework_id?: string } | null)?.framework_id ?? null;
    if (frameworkId) {
      const { data: lvlRows } = await service
        .from('proficiency_levels')
        .select('code, sort_order, label')
        .eq('framework_id', frameworkId)
        .order('sort_order', { ascending: true });
      levelInputs = ((lvlRows ?? []) as Array<{ code: string; sort_order: number; label: string | null }>).map(
        (r) => ({ code: r.code, sortOrder: r.sort_order, label: r.label }),
      );
    }
  }

  const modules = await repo.listModules(ensured.versionId, interfaceLanguage);
  const completed = await completedKeySet(service, userId, ensured.idToKey);

  const subtopicsByModule = new Map<string, string[]>();
  for (const s of ensured.ordered) {
    const arr = subtopicsByModule.get(s.moduleKey) ?? [];
    arr.push(s.subtopicKey);
    subtopicsByModule.set(s.moduleKey, arr);
  }

  // Fallback: if proficiency_levels is unavailable, derive the ladder from the
  // modules' level codes so the tree is never empty.
  if (levelInputs.length === 0) {
    const seen = new Map<string, number>();
    for (const m of modules) if (!seen.has(m.levelCode)) seen.set(m.levelCode, seen.size + 1);
    levelInputs = [...seen.entries()].map(([code, sortOrder]) => ({ code, sortOrder, label: code }));
  }

  const tree = assembleCurriculumTree({
    interfaceLanguage,
    status: ensured.status,
    levels: levelInputs,
    modules: modules.map((m) => ({
      moduleKey: m.moduleKey,
      levelCode: m.levelCode,
      title: m.title,
      sortOrder: m.sortOrder,
    })),
    subtopicKeysByModule: subtopicsByModule,
    completedSubtopicKeys: completed,
    currentSubtopicKey: ensured.currentSubtopicKey,
  });

  res.status(200).json({
    versionId: ensured.versionId,
    learningLanguage: ensured.languageContext.learningLanguage,
    interfaceLanguage,
    status: tree.status,
    currentLevelCode: tree.currentLevelCode,
    levels: tree.levels,
  });
}

async function handlePlan(res: any, userId: string, service: any): Promise<void> {
  const ensured = await ensureUserCurriculum(service, userId);
  const repo = new SupabaseCurriculumRepository(service);
  const modules = await repo.listModules(ensured.versionId, ensured.languageContext.interfaceLanguage);
  const completed = await completedKeySet(service, userId, ensured.idToKey);

  const subtopicsByModule = new Map<string, string[]>();
  for (const s of ensured.ordered) {
    const arr = subtopicsByModule.get(s.moduleKey) ?? [];
    arr.push(s.subtopicKey);
    subtopicsByModule.set(s.moduleKey, arr);
  }

  const currentModuleKey = ensured.currentSubtopicKey ? moduleKeyOf(ensured.currentSubtopicKey) : null;

  const levelsMap = new Map<string, { code: string; modules: any[] }>();
  for (const m of modules) {
    const subs = subtopicsByModule.get(m.moduleKey) ?? [];
    const done = subs.filter((k) => completed.has(k)).length;
    const total = subs.length;
    let state: ModuleState = 'upcoming';
    if (total > 0 && done === total) state = 'completed';
    else if (m.moduleKey === currentModuleKey) state = 'current';
    const lvl = levelsMap.get(m.levelCode) ?? { code: m.levelCode, modules: [] };
    // NOTE: recorte keys are INTERNAL — we expose only counts, never the keys.
    lvl.modules.push({
      title: m.title,
      capability: m.capability,
      state,
      completedCount: done,
      totalCount: total,
    });
    levelsMap.set(m.levelCode, lvl);
  }

  const levels = [...levelsMap.values()];
  res.status(200).json({
    status: ensured.status,
    learningLanguage: ensured.languageContext.learningLanguage,
    interfaceLanguage: ensured.languageContext.interfaceLanguage,
    currentLevel: ensured.currentSubtopicKey ? ensured.currentSubtopicKey.slice(0, 2) : null,
    levels,
  });
}

async function handleGetPreferences(res: any, userId: string, service: any): Promise<void> {
  const ensured = await ensureUserCurriculum(service, userId);
  res.status(200).json({
    learningLanguage: ensured.languageContext.learningLanguage,
    interfaceLanguage: ensured.languageContext.interfaceLanguage,
    modalities: ensured.prefs,
  });
}

async function handlePutPreferences(req: any, res: any, userId: string, service: any): Promise<void> {
  const raw = await readRawBody(req, 4096);
  let body: any;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return jsonError(res, 400, 'INVALID_REQUEST', 'JSON inválido.'); }

  const ensured = await ensureUserCurriculum(service, userId);
  const cur = ensured.prefs;
  const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const next = {
    writing: asBool(body?.writing, cur.writing),
    listening: asBool(body?.listening, cur.listening),
    pronunciation: asBool(body?.pronunciation, cur.pronunciation),
    conversation: asBool(body?.conversation, cur.conversation),
  };
  // Guard: at least one modality must be selected (otherwise no recorte can complete).
  if (!next.writing && !next.listening && !next.pronunciation && !next.conversation) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Selecione ao menos uma modalidade.');
  }

  await service.from('user_curriculum_preferences').update({
    practice_writing: next.writing,
    practice_listening: next.listening,
    practice_pronunciation: next.pronunciation,
    practice_conversation: next.conversation,
    updated_at: new Date().toISOString(),
  })
    .eq('user_id', userId)
    .eq('curriculum_version_id', ensured.versionId);

  safeLog('curriculum', 'preferences_updated', 200, {
    w: next.writing, l: next.listening, p: next.pronunciation, c: next.conversation,
  });
  res.status(200).json({ modalities: next });
}

async function handleProgress(res: any, userId: string, service: any): Promise<void> {
  const ensured = await ensureUserCurriculum(service, userId);
  const completed = await completedKeySet(service, userId, ensured.idToKey);
  const total = ensured.ordered.length;
  const done = ensured.ordered.filter((s) => completed.has(s.subtopicKey)).length;
  const currentModuleKey = ensured.currentSubtopicKey ? moduleKeyOf(ensured.currentSubtopicKey) : null;

  let currentModuleTitle: string | null = null;
  if (currentModuleKey) {
    const repo = new SupabaseCurriculumRepository(service);
    const mod = await repo.getModuleByKey(ensured.versionId, currentModuleKey, ensured.languageContext.interfaceLanguage);
    currentModuleTitle = mod?.title ?? null;
  }

  res.status(200).json({
    status: ensured.status,
    currentLevel: ensured.currentSubtopicKey ? ensured.currentSubtopicKey.slice(0, 2) : null,
    currentModuleTitle, // friendly, macro-level; recorte key intentionally NOT exposed
    completedRecortes: done,
    totalRecortes: total,
  });
}
