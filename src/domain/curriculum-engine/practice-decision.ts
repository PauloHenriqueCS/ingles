/**
 * Pure decision function for "a practice was recorded" — no I/O.
 *
 * Given the user's preferences, the ordered curriculum, the practiced modalities
 * per subtopic (AFTER adding the new practice) and the previously-completed set,
 * it returns which subtopics became complete and the new curriculum position.
 *
 * This isolates ALL progression rules from the database glue so they are unit
 * tested exhaustively (see practice-decision.test.ts).
 */

import {
  computeCurriculumState,
  recomputeCompleted,
  type CurriculumState,
  type CurricularModality,
  type ModalityPreferences,
  type OrderedSubtopic,
} from './progression';

export interface PracticeDecisionInput {
  prefs: ModalityPreferences;
  orderedSubtopics: readonly OrderedSubtopic[];
  /** Practiced modalities per subtopic key, AFTER applying the new practice. */
  practicedBySubtopic: ReadonlyMap<string, ReadonlySet<CurricularModality>>;
  /** Subtopics already marked completed before this practice. */
  previousCompleted: ReadonlySet<string>;
}

export interface PracticeDecision {
  /** Subtopics that became complete as a result of this practice (usually 0 or 1). */
  completedNow: string[];
  /** The full recomputed completed set (never smaller than previousCompleted
   *  unless preferences changed — completion is derived, records are never lost). */
  allCompleted: Set<string>;
  /** New curriculum position after applying completions. */
  state: CurriculumState;
}

export function decidePractice(input: PracticeDecisionInput): PracticeDecision {
  const allCompleted = recomputeCompleted(input.prefs, input.practicedBySubtopic);
  // Union with previouslyCompleted so a preference change that ADDS a requirement
  // never "uncompletes" a recorte the user already cleared under the old rule.
  for (const k of input.previousCompleted) allCompleted.add(k);
  const completedNow = [...allCompleted].filter((k) => !input.previousCompleted.has(k));
  const state = computeCurriculumState(input.orderedSubtopics, allCompleted);
  return { completedNow, allCompleted, state };
}
