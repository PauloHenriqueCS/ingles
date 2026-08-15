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
import { decidePractice } from '../../src/domain/curriculum-engine/practice-decision';
import type { CurricularModality, ModalityPreferences, OrderedSubtopic } from '../../src/domain/curriculum-engine/progression';
import type { LanguageContext } from '../../src/domain/curriculum-engine/language-context';
import type { ComposedPrompt } from '../../src/domain/curriculum-engine/prompt-composer';
import { CURRICULUM_BOOTSTRAP_DEFAULT } from '../../src/config/curriculum-defaults';

export { CurriculumConfigError };

interface EnsuredCurriculum {
  versionId: string;
  languageContext: LanguageContext;
  prefs: ModalityPreferences;
  currentSubtopicKey: string | null;
  currentSubtopicId: string | null;
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

async function resolveUserLevel(client: SupabaseClient, userId: string): Promise<string | null> {
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

/**
 * Ensures preferences + progress exist for the user against the CURRENT published
 * curriculum for their learning language. Idempotent and safe for existing users.
 */
export async function ensureUserCurriculum(client: SupabaseClient, userId: string): Promise<EnsuredCurriculum> {
  const repo = new SupabaseCurriculumRepository(client);

  // 1) Language context: from prefs if present, else bootstrap default.
  const { data: prefsData } = await client
    .from('user_curriculum_preferences')
    .select('learning_language, interface_language, practice_writing, practice_listening, practice_pronunciation, practice_conversation, curriculum_version_id')
    .eq('user_id', userId)
    .maybeSingle();
  const existingPrefs = (prefsData ?? null) as (PrefsRow & { curriculum_version_id: string }) | null;

  const languageContext: LanguageContext = existingPrefs
    ? { learningLanguage: existingPrefs.learning_language, interfaceLanguage: existingPrefs.interface_language }
    : { ...CURRICULUM_BOOTSTRAP_DEFAULT };

  // 2) Published version for the learning language.
  const version = await repo.getPublishedVersion(languageContext.learningLanguage);
  if (!version) {
    throw new CurriculumConfigError(
      `No published curriculum for learning_language="${languageContext.learningLanguage}"`,
    );
  }

  const ordered = await repo.listOrderedSubtopics(version.id);
  const pairs = await repo.listSubtopicIdKeyPairs(version.id);
  const keyToId = new Map(pairs.map((p) => [p.subtopicKey, p.id]));
  const idToKey = new Map(pairs.map((p) => [p.id, p.subtopicKey]));

  // 3) Ensure preferences row.
  let prefs: ModalityPreferences;
  if (existingPrefs && existingPrefs.curriculum_version_id === version.id) {
    prefs = rowToPrefs(existingPrefs);
  } else {
    prefs = existingPrefs ? rowToPrefs(existingPrefs) : DEFAULT_PREFS;
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
      { onConflict: 'user_id,curriculum_version_id' },
    );
  }

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
    // Bootstrap: first recorte of the user's current level (fallback: very first).
    const level = (await resolveUserLevel(client, userId)) ?? ordered[0]?.levelCode ?? null;
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
    languageContext,
    prefs,
    currentSubtopicKey,
    currentSubtopicId,
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
  subtopicKey: string | null;
  completedNow: string[];
  currentSubtopicKey: string | null;
  status: 'active' | 'curriculum_completed';
}

/**
 * Records ONE valid practice of `modality` for the user's CURRENT recorte and,
 * if all selected modalities are now practised, marks the recorte complete and
 * advances. Idempotent per (user, subtopic, modality). Practising the same
 * modality again is harmless and never regresses.
 */
export async function recordCurricularPractice(
  client: SupabaseClient,
  userId: string,
  modality: CurricularModality,
  sourceRef?: string | null,
): Promise<RecordPracticeResult> {
  const ensured = await ensureUserCurriculum(client, userId);
  if (!ensured.currentSubtopicId || !ensured.currentSubtopicKey) {
    return { recorded: false, subtopicKey: null, completedNow: [], currentSubtopicKey: null, status: ensured.status };
  }

  const currentId = ensured.currentSubtopicId;
  const currentKey = ensured.currentSubtopicKey;

  // 1) Upsert the practice record (idempotent per user+subtopic+modality).
  await client.from('user_subtopic_modality_progress').upsert(
    {
      user_id: userId,
      subtopic_id: currentId,
      modality,
      status: 'practiced',
      source_ref: sourceRef ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,subtopic_id,modality' },
  );

  // 2) Practised modalities for the current recorte.
  const { data: practicedData } = await client
    .from('user_subtopic_modality_progress')
    .select('modality')
    .eq('user_id', userId)
    .eq('subtopic_id', currentId);
  const practicedRows = (practicedData ?? []) as Array<{ modality: CurricularModality }>;
  const practicedSet = new Set<CurricularModality>(practicedRows.map((r) => r.modality));

  // 3) Previously-completed keys for this user (mapped id → key).
  const { data: completedData } = await client
    .from('user_subtopic_completion')
    .select('subtopic_id')
    .eq('user_id', userId);
  const completedRows = (completedData ?? []) as Array<{ subtopic_id: string }>;
  const previousCompleted = new Set<string>(
    completedRows.map((r) => ensured.idToKey.get(r.subtopic_id)).filter((k): k is string => !!k),
  );

  // 4) Pure decision.
  const decision = decidePractice({
    prefs: ensured.prefs,
    orderedSubtopics: ensured.ordered,
    practicedBySubtopic: new Map([[currentKey, practicedSet]]),
    previousCompleted,
  });

  // 5) Persist newly-completed recortes + advance the pointer.
  if (decision.completedNow.length > 0) {
    const rows = decision.completedNow
      .map((key) => ensured.keyToId.get(key))
      .filter((id): id is string => !!id)
      .map((id) => ({ user_id: userId, subtopic_id: id }));
    if (rows.length > 0) {
      await client.from('user_subtopic_completion').upsert(rows, { onConflict: 'user_id,subtopic_id' });
    }

    const nextKey = decision.state.currentSubtopicKey;
    const nextId = nextKey ? ensured.keyToId.get(nextKey) ?? null : null;
    let nextModuleId: string | null = null;
    if (nextKey) {
      const sub = await new SupabaseCurriculumRepository(client).getSubtopicByKey(
        ensured.versionId,
        nextKey,
        ensured.languageContext.interfaceLanguage,
      );
      nextModuleId = sub?.moduleId ?? null;
    }
    await client.from('user_curriculum_progress').update({
      current_subtopic_id: nextId,
      current_module_id: nextModuleId,
      current_level_code: decision.state.currentLevelCode,
      status: decision.state.status,
      updated_at: new Date().toISOString(),
    })
      .eq('user_id', userId)
      .eq('curriculum_version_id', ensured.versionId);
  }

  return {
    recorded: true,
    subtopicKey: currentKey,
    completedNow: decision.completedNow,
    currentSubtopicKey: decision.state.currentSubtopicKey,
    status: decision.state.status,
  };
}
