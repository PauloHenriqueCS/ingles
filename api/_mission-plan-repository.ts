/**
 * @deprecated RETIRED. The hardcoded English pedagogical planner is gone —
 * Writing generation is now data-driven via the curriculum engine
 * (api/_curriculum/curriculum-runtime.ts + DB prompt templates).
 *
 * This module used to read/write `mission_pedagogical_plans`, a table that was
 * never applied to the production database. It is intentionally NEUTRALIZED so
 * nothing runs "half-alive" or writes silently to a missing table: every export
 * throws loudly if called. No import from the live path references it anymore.
 */

const RETIRED = 'mission_pedagogical_plans planner is retired — Writing is data-driven via the curriculum engine.';

/** @deprecated retired planner type — kept only so stale imports still resolve. */
export type MissionPlanRow = Record<string, unknown>;
/** @deprecated retired planner type — kept only so stale imports still resolve. */
export type InsertMissionPlanParams = Record<string, unknown>;

/** @deprecated retired — no-op that throws. */
export async function insertMissionPlan(): Promise<MissionPlanRow | null> {
  throw new Error(RETIRED);
}
/** @deprecated retired — no-op that throws. */
export async function getMissionPlanById(): Promise<MissionPlanRow | null> {
  throw new Error(RETIRED);
}
/** @deprecated retired — no-op that throws. */
export async function getLatestPlanForUser(): Promise<MissionPlanRow | null> {
  throw new Error(RETIRED);
}
/** @deprecated retired — no-op that throws. */
export async function supersedePlan(): Promise<boolean> {
  throw new Error(RETIRED);
}
/** @deprecated retired — no-op that throws. */
export async function markPlanAccepted(): Promise<boolean> {
  throw new Error(RETIRED);
}
/** @deprecated retired — no-op that throws. */
export async function getRecentPlansForUser(): Promise<MissionPlanRow[]> {
  throw new Error(RETIRED);
}
