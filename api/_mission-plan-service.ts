/**
 * @deprecated RETIRED. The hardcoded English pedagogical planner is gone —
 * Writing generation is now data-driven via the curriculum engine
 * (api/_curriculum/curriculum-runtime.ts + DB prompt templates).
 *
 * This service used to run planWritingMission() against the hardcoded
 * GRAMMAR_CATALOG and persist to `mission_pedagogical_plans` (a table never
 * applied to production). It is intentionally NEUTRALIZED so nothing runs
 * "half-alive": generatePedagogicalPlan() no longer touches the database and
 * always reports "skipped". No import from the live path references it anymore.
 */

/** @deprecated retired planner input — kept only so stale imports still resolve. */
export interface PlanGenerationInput {
  userId: string;
  mode: string;
  seed: string;
  [key: string]: unknown;
}

/** @deprecated retired planner result — planner is disabled; always skipped. */
export interface PlanGenerationResult {
  plan: null;
  planId: null;
  shadowMode: false;
  skipped: true;
}

/**
 * @deprecated retired — inert no-op. Returns a "skipped" result without any
 * database access. The pedagogical planner has been replaced by the data-driven
 * curriculum engine; this exists only to keep any stale import type-safe.
 */
export async function generatePedagogicalPlan(): Promise<PlanGenerationResult> {
  return { plan: null, planId: null, shadowMode: false, skipped: true };
}
