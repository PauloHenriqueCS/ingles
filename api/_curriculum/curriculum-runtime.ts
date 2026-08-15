/**
 * SERVER-ONLY curriculum runtime — the seam every activity calls.
 *
 * Responsibilities (glue only; all pedagogical rules live in the pure engine):
 *   - resolve the user's LanguageContext (prefs → bootstrap default)
 *   - ensure a user has curriculum preferences + progress (safe bootstrap for
 *     existing users with no progress: start at the first recorte of their
 *     current level; NO invented mastery/history)
 *   - resolveActivityPrompt: compose the DB-sourced prompt for the user's current
 *     recorte (throws an explicit CurriculumConfigError if misconfigured — never
 *     a silent hardcoded English fallback)
 *   - recordCurricularPractice: record ONE valid practice for a modality and
 *     advance the recorte when ALL selected modalities are practised
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SupabaseCurriculumRepository,
  CurriculumConfigError,
} from '../../src/domain/curriculum-engine/curriculum-repository';
import { resolveCurriculumPrompt } from '../../src/domain/curriculum-engine/resolve-curriculum-prompt';
import type { CurricularModality, ModalityPreferences, OrderedSubtopic } from '../../src/domain/curriculum-engine/progression';
import type { LanguageContext } from '../../src/domain/curriculum-engine/language-context';
import type { ComposedPrompt } from '../../src/domain/curriculum-engine/prompt-composer';
import { CURRICULUM_BOOTSTRAP_DEFAULT } from '../../src/config/curriculum-defaults';

export { CurriculumConfigError };

interface EnsuredCurriculum {
  versionId: string;
  /** curriculum id of the pinned version (for framework lookups) — no "latest published". */
  curriculumId: string;
  languageContext: LanguageContext;
  prefs: ModalityPreferences;
  currentSubtopicKey: string | null;
  currentSubtopicId: string | null;
  /** Current level of the PINNED path (authority for this language, not english_learning_memory). */
  currentLevelCode: string | null;
  status: 'active' | 'curriculum_completed';
  ordered: OrderedSubtopic[];
  keyToId: Map<string, string>;
  idToKey: Map<string, string>;
}

interface PrefsRow {
  learning_language: string;
  interface_language: string;
  practice_writing: boolean;
  practice_listening: boolean;
  practice_pronunciation: boolean;
  practice_conversation: boolean;
}

function rowToPrefs(row: PrefsRow): ModalityPreferences {
  return {
    writing: row.practice_writing,
    listening: row.practice_listening,
    pronunciation: row.practice_pronunciation,
    conversation: row.practice_conversation,
  };
}

const DEFAULT_PREFS: ModalityPreferences = {
  writing: true,
  listening: true,
  pronunciation: true,
  conversation: false,
};

/**
 * LEGACY English-V1 ONLY: the user's pre-curriculum English level, read once at
 * path CREATION to preserve an existing learner's level. NOT a generic runtime
 * level authority — a new language never consults it (blocker 8). After
 * bootstrap the authority is user_curriculum_progress.current_level_code.
 */
async function resolveLegacyEnglishLevel(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await client
    .from('english_learning_memory')
    .select('current_level')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = (data ?? null) as { current_level?: string | null } | null;
  return row?.current_level ?? null;
}

interface ActivePathRow {
  learning_language: string;
  interface_language: string;
  curriculum_version_id: string;
  initial_level_code: string | null;
}

async function readActivePath(client: SupabaseClient, userId: string): Promise<ActivePathRow | null> {
  const { data, error } = await client
    .from('user_learning_paths')
    .select('learning_language, interface_language, curriculum_version_id, initial_level_code')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  // A transient READ error must NOT be mistaken for "no path" (which would
  // trigger a bootstrap and silently pick English). Propagate it explicitly so
  // Speech/curriculum return an operational error, never an English fallback.
  if (error) {
    throw new CurriculumConfigError(`Failed to read active learning path for user ${userId}: ${error.message}`);
  }
  return (data ?? null) as ActivePathRow | null;
}

/**
 * The user's ACTIVE learning language — the SAME single authority every runtime
 * read shares (never inferred from prefs.updated_at). Reads the active learning
 * path; if the user has none yet, bootstraps one (server-authoritative, via
 * ensureUserCurriculum). A read/bootstrap FAILURE propagates — it is NEVER
 * silently recovered to English (blocker 1). Shared by ensureUserCurriculum's
 * callers and the Speech resolver so there is no duplicated active-path logic.
 */
export async function resolveActiveLearningLanguage(client: SupabaseClient, userId: string): Promise<string> {
  const path = await readActivePath(client, userId);
  if (path) return path.learning_language;
  // No active path yet → genuine bootstrap (creates the path). This requires the
  // service-role writes ensureUserCurriculum performs — callers pass the service
  // client for Speech, so RLS is honoured, not bypassed.
  const ensured = await ensureUserCurriculum(client, userId);
  return ensured.languageContext.learningLanguage;
}

/**
 * Ensures the user's ACTIVE LEARNING PATH (explicit pointer to the pinned
 * curriculum version + language + interface + per-language initial level),
 * preferences and progress. Idempotent and safe for existing users. The active
 * path — NOT "latest published" and NOT an updated_at heuristic — is the single
 * authority every runtime read shares (blockers 1, 8).
 */
export async function ensureUserCurriculum(client: SupabaseClient, userId: string): Promise<EnsuredCurriculum> {
  const repo = new SupabaseCurriculumRepository(client);

  let activePath = await readActivePath(client, userId);
  let version;
  let languageContext: LanguageContext;
  let initialLevelCode: string | null;

  if (activePath) {
    // Honour the PINNED version of the active path — load it by id, never the
    // latest published one. Publishing V2 leaves this path untouched.
    version = await repo.getVersionById(activePath.curriculum_version_id);
    if (!version) {
      throw new CurriculumConfigError(
        `Pinned curriculum version ${activePath.curriculum_version_id} for user ${userId} not found`,
      );
    }
    languageContext = { learningLanguage: activePath.learning_language, interfaceLanguage: activePath.interface_language };
    initialLevelCode = activePath.initial_level_code;
  } else {
    // BOOTSTRAP a NEW active path. The product default language (English V1
    // today) is the ONLY place "latest published" is resolved and the only place
    // a language literal enters — product config, not pedagogy. The legacy
    // English level is consulted ONCE here purely to preserve an existing
    // learner; a genuinely new language would NOT inherit any English level.
    languageContext = { ...CURRICULUM_BOOTSTRAP_DEFAULT };
    const published = await repo.getPublishedVersion(languageContext.learningLanguage);
    if (!published) {
      throw new CurriculumConfigError(
        `No published curriculum for learning_language="${languageContext.learningLanguage}"`,
      );
    }
    version = published;
    initialLevelCode = languageContext.learningLanguage === CURRICULUM_BOOTSTRAP_DEFAULT.learningLanguage
      ? await resolveLegacyEnglishLevel(client, userId)
      : null;
    // Create the active path (race-safe: one active per user + one per language).
    // ignoreDuplicates → a concurrent bootstrap is a harmless no-op.
    await client.from('user_learning_paths').upsert(
      {
        user_id: userId,
        learning_language: languageContext.learningLanguage,
        curriculum_version_id: version.id,
        interface_language: languageContext.interfaceLanguage,
        initial_level_code: initialLevelCode,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,learning_language', ignoreDuplicates: true },
    );
    // Re-read the AUTHORITATIVE active path (ours, or a concurrent winner's).
    activePath = (await readActivePath(client, userId)) ?? {
      learning_language: languageContext.learningLanguage,
      interface_language: languageContext.interfaceLanguage,
      curriculum_version_id: version.id,
      initial_level_code: initialLevelCode,
    };
    version = (await repo.getVersionById(activePath.curriculum_version_id)) ?? version;
    languageContext = { learningLanguage: activePath.learning_language, interfaceLanguage: activePath.interface_language };
    initialLevelCode = activePath.initial_level_code;
  }

  // 2) Ensure the prefs row for THIS (user, pinned version). Scoped read — no
  //    ambiguity across versions.
  const { data: prefsData } = await client
    .from('user_curriculum_preferences')
    .select('practice_writing, practice_listening, practice_pronunciation, practice_conversation')
    .eq('user_id', userId)
    .eq('curriculum_version_id', version.id)
    .maybeSingle();
  let prefs: ModalityPreferences;
  if (prefsData) {
    prefs = rowToPrefs({
      ...(prefsData as Record<string, boolean>),
      learning_language: languageContext.learningLanguage,
      interface_language: languageContext.interfaceLanguage,
    } as PrefsRow);
  } else {
    prefs = DEFAULT_PREFS;
    await client.from('user_curriculum_preferences').upsert(
      {
        user_id: userId,
        curriculum_version_id: version.id,
        learning_language: languageContext.learningLanguage,
        interface_language: languageContext.interfaceLanguage,
        practice_writing: prefs.writing,
        practice_listening: prefs.listening,
        practice_pronunciation: prefs.pronunciation,
        practice_conversation: prefs.conversation,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,curriculum_version_id', ignoreDuplicates: true },
    );
  }

  const ordered = await repo.listOrderedSubtopics(version.id);
  const pairs = await repo.listSubtopicIdKeyPairs(version.id);
  const keyToId = new Map(pairs.map((p) => [p.subtopicKey, p.id]));
  const idToKey = new Map(pairs.map((p) => [p.id, p.subtopicKey]));

  // 4) Ensure progress row (safe bootstrap for existing users).
  const { data: progData } = await client
    .from('user_curriculum_progress')
    .select('current_subtopic_id, current_module_id, current_level_code, status')
    .eq('user_id', userId)
    .eq('curriculum_version_id', version.id)
    .maybeSingle();
  let prog = (progData ?? null) as
    | { current_subtopic_id: string | null; current_module_id: string | null; current_level_code: string | null; status: 'active' | 'curriculum_completed' }
    | null;

  if (!prog) {
    // Bootstrap: first recorte of the PATH's initial level (per-language, NOT a
    // global english_learning_memory level). New-language paths have a null
    // initial level → start at the very first recorte (blocker 8).
    const level = initialLevelCode ?? ordered[0]?.levelCode ?? null;
    const firstOfLevel = ordered.find((s) => s.levelCode === level) ?? ordered[0] ?? null;
    const currentKey = firstOfLevel?.subtopicKey ?? null;
    const currentId = currentKey ? keyToId.get(currentKey) ?? null : null;
    const moduleId = currentKey
      ? (await repo.getSubtopicByKey(version.id, currentKey, languageContext.interfaceLanguage))?.moduleId ?? null
      : null;
    // INSERT-IF-ABSENT — never clobber a row a concurrent first-access request
    // may have already created AND advanced. ignoreDuplicates → ON CONFLICT DO
    // NOTHING, so a racing bootstrap is a harmless no-op and can never reset an
    // advanced pointer back to the first recorte.
    await client.from('user_curriculum_progress').upsert(
      {
        user_id: userId,
        curriculum_version_id: version.id,
        current_level_code: firstOfLevel?.levelCode ?? null,
        current_module_id: moduleId,
        current_subtopic_id: currentId,
        status: 'active',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,curriculum_version_id', ignoreDuplicates: true },
    );
    // Re-read the AUTHORITATIVE row: ours if we won the insert, or the concurrent
    // winner's (possibly already advanced) otherwise. Never trust the value we
    // tried to write.
    const { data: freshProg } = await client
      .from('user_curriculum_progress')
      .select('current_subtopic_id, current_module_id, current_level_code, status')
      .eq('user_id', userId)
      .eq('curriculum_version_id', version.id)
      .maybeSingle();
    prog = (freshProg ?? {
      current_subtopic_id: currentId,
      current_module_id: moduleId,
      current_level_code: firstOfLevel?.levelCode ?? null,
      status: 'active',
    }) as {
      current_subtopic_id: string | null; current_module_id: string | null;
      current_level_code: string | null; status: 'active' | 'curriculum_completed';
    };
  }

  const currentSubtopicId = prog.current_subtopic_id;
  const currentSubtopicKey = currentSubtopicId ? idToKey.get(currentSubtopicId) ?? null : null;

  return {
    versionId: version.id,
    curriculumId: version.curriculumId,
    languageContext,
    prefs,
    currentSubtopicKey,
    currentSubtopicId,
    currentLevelCode: prog.current_level_code,
    status: prog.status,
    ordered,
    keyToId,
    idToKey,
  };
}

export interface ResolveActivityPromptOptions {
  templateKey: string;
  activityType: string;
  /** When false, composes a level/language-only prompt (no recorte required). */
  requireSubtopic?: boolean;
  userContext?: Record<string, string | number>;
  transversalTargets?: string[];
}

export interface ResolvedActivityPrompt extends ComposedPrompt {
  subtopicKey: string | null;
  versionId: string;
  languageContext: LanguageContext;
}

export async function resolveActivityPrompt(
  client: SupabaseClient,
  userId: string,
  opts: ResolveActivityPromptOptions,
): Promise<ResolvedActivityPrompt> {
  const ensured = await ensureUserCurriculum(client, userId);
  const requireSubtopic = opts.requireSubtopic !== false;

  // Resolve the recorte to practise. Post-C2: when the curriculum is completed
  // there is no "current" recorte — we DON'T reset or invent a C3. Instead we
  // enter a continuous refinement mode using the LAST recorte in the curriculum,
  // so the app keeps working and generating aligned content. This requires no
  // change in any consumer.
  let subtopicKey: string | null = requireSubtopic ? ensured.currentSubtopicKey : null;
  if (requireSubtopic && !subtopicKey) {
    if (ensured.status === 'curriculum_completed' && ensured.ordered.length > 0) {
      subtopicKey = ensured.ordered[ensured.ordered.length - 1].subtopicKey;
    } else {
      throw new CurriculumConfigError(
        `User ${userId} has no current subtopic (status=${ensured.status})`,
      );
    }
  }

  const composed = await resolveCurriculumPrompt({
    repository: new SupabaseCurriculumRepository(client),
    languageContext: ensured.languageContext,
    templateKey: opts.templateKey,
    activityType: opts.activityType,
    subtopicKey,
    versionId: ensured.versionId, // PINNED version — never "latest published"
    transversalTargets: opts.transversalTargets,
    userContext: opts.userContext,
  });

  return {
    ...composed,
    subtopicKey,
    versionId: ensured.versionId,
    languageContext: ensured.languageContext,
  };
}

export interface RecordPracticeResult {
  recorded: boolean;
  /** The recorte the practice was recorded against (its ORIGIN, not necessarily current). */
  subtopicKey: string | null;
  /** The version the practice was recorded under (the user's pinned version). */
  versionId: string | null;
  /** Current recorte AFTER the atomic resync (null when curriculum_completed). */
  currentSubtopicKey: string | null;
  status: 'active' | 'curriculum_completed';
}

/**
 * The curricular identity an activity CARRIED when it was created/generated —
 * persisted on the activity resource (which the user owns) and read server-side
 * at completion. Passing it makes the practice land on the recorte the activity
 * was ORIGINATED for, never on whatever recorte happens to be current now (which
 * may have advanced meanwhile). See blockers 8 & 10.
 */
export interface CurricularActivityIdentity {
  versionId: string;
  subtopicKey: string;
}

// Shared core: upsert the practice on an ALREADY-RESOLVED recorte + atomic
// resync. Never resolves "current" itself — the caller decides the target.
async function recordPracticeOnSubtopic(
  client: SupabaseClient,
  userId: string,
  modality: CurricularModality,
  sourceRef: string | null | undefined,
  ensured: Awaited<ReturnType<typeof ensureUserCurriculum>>,
  targetSubtopicKey: string,
): Promise<RecordPracticeResult> {
  const targetSubtopicId = ensured.keyToId.get(targetSubtopicKey) ?? null;
  if (!targetSubtopicId) {
    return { recorded: false, subtopicKey: null, versionId: ensured.versionId, currentSubtopicKey: ensured.currentSubtopicKey, status: ensured.status };
  }
  // Idempotent per (user, subtopic, modality) — a retry/refresh never duplicates.
  await client.from('user_subtopic_modality_progress').upsert(
    {
      user_id: userId,
      subtopic_id: targetSubtopicId,
      modality,
      status: 'practiced',
      source_ref: sourceRef ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,subtopic_id,modality' },
  );
  // Atomic, advisory-locked recompute of completion + pointer from persisted
  // facts (safe under concurrency; never double-advances, never regresses).
  const resync = await resyncCurriculumProgress(client, userId, ensured.versionId);
  return {
    recorded: true,
    subtopicKey: targetSubtopicKey,
    versionId: ensured.versionId,
    currentSubtopicKey: resync.currentSubtopicKey,
    status: resync.status,
  };
}

/**
 * IDENTITY-REQUIRED recording for activities with their OWN lifecycle
 * (pronunciation, listening, conversation, writing mission). The practice is
 * recorded against the recorte the activity was ORIGINATED for — NEVER the
 * current pointer. If the identity is absent/incomplete (legacy resource,
 * missing/failed persistence) or points at a different version, NO curricular
 * credit is granted (blocker 5): the activity may still complete
 * commercially/functionally, but it never silently marks the current recorte.
 */
export async function recordCurricularPracticeFromIdentity(
  client: SupabaseClient,
  userId: string,
  modality: CurricularModality,
  sourceRef: string | null | undefined,
  identity: CurricularActivityIdentity | null | undefined,
): Promise<RecordPracticeResult> {
  const ensured = await ensureUserCurriculum(client, userId);
  // No fallback to the current pointer — identity is mandatory and must match
  // the user's pinned version.
  if (!identity || !identity.versionId || !identity.subtopicKey || identity.versionId !== ensured.versionId) {
    return { recorded: false, subtopicKey: null, versionId: ensured.versionId, currentSubtopicKey: ensured.currentSubtopicKey, status: ensured.status };
  }
  return recordPracticeOnSubtopic(client, userId, modality, sourceRef, ensured, identity.subtopicKey);
}

/**
 * INSTANTANEOUS recording for a same-request activity whose recorte is trivially
 * the CURRENT one (there is no persisted resource whose identity could drift —
 * the practice IS its own completion in the same request). Do NOT use this for
 * activities with their own lifecycle; use recordCurricularPracticeFromIdentity.
 */
export async function recordCurricularPractice(
  client: SupabaseClient,
  userId: string,
  modality: CurricularModality,
  sourceRef?: string | null,
): Promise<RecordPracticeResult> {
  const ensured = await ensureUserCurriculum(client, userId);
  if (!ensured.currentSubtopicKey) {
    return { recorded: false, subtopicKey: null, versionId: ensured.versionId, currentSubtopicKey: null, status: ensured.status };
  }
  return recordPracticeOnSubtopic(client, userId, modality, sourceRef, ensured, ensured.currentSubtopicKey);
}

export interface ResyncResult {
  currentSubtopicKey: string | null;
  status: 'active' | 'curriculum_completed';
}

/**
 * Atomically recomputes the user's curriculum completion + current pointer from
 * the persisted facts (practices per recorte + the CURRENT modality menu). Used
 * after a practice AND after a preferences change ("menu = regra"): removing the
 * last pending modality can complete/advance the current recorte immediately,
 * with NO artificial practice required; adding a modality never regresses an
 * already-completed recorte. Race-safe via the RPC's per-user advisory lock.
 *
 * `versionId` defaults to the user's pinned version when omitted.
 */
export async function resyncCurriculumProgress(
  client: SupabaseClient,
  userId: string,
  versionId?: string,
): Promise<ResyncResult> {
  let resolvedVersionId = versionId;
  let idToKey: Map<string, string> | null = null;
  if (!resolvedVersionId) {
    const ensured = await ensureUserCurriculum(client, userId);
    resolvedVersionId = ensured.versionId;
    idToKey = ensured.idToKey;
  }

  const { data, error } = await client.rpc('resync_curriculum_progress', {
    p_user_id: userId,
    p_curriculum_version_id: resolvedVersionId,
  });
  if (error) throw new CurriculumConfigError(`resync_curriculum_progress failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { current_subtopic_id: string | null; status: string }
    | undefined;
  const status = (row?.status === 'curriculum_completed' ? 'curriculum_completed' : 'active') as ResyncResult['status'];

  // Map the returned subtopic id → semantic key (load the map only if we didn't
  // already have it from a bootstrap ensure above).
  if (!idToKey) {
    const pairs = await new SupabaseCurriculumRepository(client).listSubtopicIdKeyPairs(resolvedVersionId);
    idToKey = new Map(pairs.map((p) => [p.id, p.subtopicKey]));
  }
  const currentSubtopicKey = row?.current_subtopic_id ? idToKey.get(row.current_subtopic_id) ?? null : null;

  return { currentSubtopicKey, status };
}
