/**
 * @deprecated RETIRED. The hardcoded English pedagogical planner is gone —
 * Writing generation is now data-driven via the curriculum engine
 * (api/_curriculum/curriculum-runtime.ts + DB prompt templates).
 *
 * This module used to read `learner_skill_profiles` / `learner_grammar_mastery`
 * (tables never applied to production) to build a planner snapshot. It is
 * intentionally NEUTRALIZED so nothing runs "half-alive" or reads silently from
 * a missing table: the export throws loudly if called. No import from the live
 * path references it anymore.
 */

/** @deprecated retired — no-op that throws. */
export async function loadLearnerPlanningSnapshot(): Promise<never> {
  throw new Error(
    'learner planning snapshot is retired — Writing is data-driven via the curriculum engine.',
  );
}
