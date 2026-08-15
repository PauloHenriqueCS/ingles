/**
 * Curriculum progression — pure domain logic (no DB, no I/O).
 *
 * Core rule (from the approved spec):
 *   A recorte (subtopic) is COMPLETE when the user has a valid practice in
 *   EVERY modality they selected. Menu = rule: a selected modality is a hard
 *   requirement; an unselected one never blocks. Review is NOT a curricular
 *   modality and never appears here.
 *
 * Non-goals encoded on purpose:
 *   - No calendar coupling: a recorte can span days or several can finish in one
 *     day. This module is date-agnostic.
 *   - No mastery score: "practiced" is a fact, not a certification.
 */

export type CurricularModality = 'writing' | 'listening' | 'pronunciation' | 'conversation';

export const ALL_CURRICULAR_MODALITIES: readonly CurricularModality[] = [
  'writing',
  'listening',
  'pronunciation',
  'conversation',
];

export interface ModalityPreferences {
  writing: boolean;
  listening: boolean;
  pronunciation: boolean;
  conversation: boolean;
}

export function selectedModalities(prefs: ModalityPreferences): CurricularModality[] {
  return ALL_CURRICULAR_MODALITIES.filter((m) => prefs[m]);
}

/**
 * True when every SELECTED modality has been practiced for this subtopic.
 * If the user selected zero modalities, no recorte can complete (guarded).
 */
export function isSubtopicComplete(
  prefs: ModalityPreferences,
  practiced: Iterable<CurricularModality>,
): boolean {
  const selected = selectedModalities(prefs);
  if (selected.length === 0) return false;
  const done = new Set(practiced);
  return selected.every((m) => done.has(m));
}

/** Modalities still required (selected but not yet practiced) for a subtopic. */
export function pendingModalities(
  prefs: ModalityPreferences,
  practiced: Iterable<CurricularModality>,
): CurricularModality[] {
  const done = new Set(practiced);
  return selectedModalities(prefs).filter((m) => !done.has(m));
}

export interface OrderedSubtopic {
  subtopicKey: string;
  moduleKey: string;
  levelCode: string;
}

export interface CurriculumState {
  currentSubtopicKey: string | null;
  currentModuleKey: string | null;
  currentLevelCode: string | null;
  status: 'active' | 'curriculum_completed';
}

/**
 * Given the ordered list of all subtopics and the set of completed subtopic
 * keys, returns the current position. The current subtopic is the first one (in
 * order) not yet completed. If all are completed → curriculum_completed.
 *
 * `orderedSubtopics` MUST already be sorted by (level.sortOrder, module.sortOrder,
 * subtopic.sortOrder) by the caller/loader — ordering is data, not derived here.
 */
export function computeCurriculumState(
  orderedSubtopics: readonly OrderedSubtopic[],
  completedKeys: ReadonlySet<string>,
): CurriculumState {
  for (const s of orderedSubtopics) {
    if (!completedKeys.has(s.subtopicKey)) {
      return {
        currentSubtopicKey: s.subtopicKey,
        currentModuleKey: s.moduleKey,
        currentLevelCode: s.levelCode,
        status: 'active',
      };
    }
  }
  return {
    currentSubtopicKey: null,
    currentModuleKey: null,
    currentLevelCode: null,
    status: 'curriculum_completed',
  };
}

/** True when every subtopic of the given module is completed. */
export function isModuleComplete(
  orderedSubtopics: readonly OrderedSubtopic[],
  moduleKey: string,
  completedKeys: ReadonlySet<string>,
): boolean {
  const inModule = orderedSubtopics.filter((s) => s.moduleKey === moduleKey);
  if (inModule.length === 0) return false;
  return inModule.every((s) => completedKeys.has(s.subtopicKey));
}

/** True when every subtopic of the given level is completed. */
export function isLevelComplete(
  orderedSubtopics: readonly OrderedSubtopic[],
  levelCode: string,
  completedKeys: ReadonlySet<string>,
): boolean {
  const inLevel = orderedSubtopics.filter((s) => s.levelCode === levelCode);
  if (inLevel.length === 0) return false;
  return inLevel.every((s) => completedKeys.has(s.subtopicKey));
}

/**
 * Recomputes the set of completed subtopics from per-subtopic practiced
 * modalities and the current preferences. Used when preferences change or when
 * a practice is recorded: a subtopic is complete iff all currently-selected
 * modalities are practiced. Changing preferences never deletes practice records;
 * it only changes what counts as "complete".
 */
export function recomputeCompleted(
  prefs: ModalityPreferences,
  practicedBySubtopic: ReadonlyMap<string, ReadonlySet<CurricularModality>>,
): Set<string> {
  const completed = new Set<string>();
  for (const [subtopicKey, practiced] of practicedBySubtopic) {
    if (isSubtopicComplete(prefs, practiced)) completed.add(subtopicKey);
  }
  return completed;
}
