import type { GeneratedMissionCandidate, PublicWritingMissionDTO } from './mission-generation-types';

const WRITING_MISSION_INTERNAL_FIELDS: ReadonlySet<string> = new Set([
  'pedagogicalPlanId',
  'validationPassed',
  'validationWarnings',
  'internalCoverage',
  'internal_coverage',
  'diagnosticPlan',
  'diagnostic_plan',
  'rejectionLog',
  'rejection_log',
  'notesForGenerator',
  'notesForValidator',
  'coverageExplanation',
  'coverage_explanation',
]);

/**
 * Strips all internal/pedagogical fields before sending a mission to the browser.
 * This is the only barrier between internal mission data and the public API.
 */
export function toPublicWritingMissionDTO(
  internal: GeneratedMissionCandidate | Record<string, unknown>,
): PublicWritingMissionDTO {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(internal)) {
    if (!WRITING_MISSION_INTERNAL_FIELDS.has(key)) {
      result[key] = value;
    }
  }
  return result as unknown as PublicWritingMissionDTO;
}

export function containsWritingMissionInternalFields(
  dto: Record<string, unknown>,
): boolean {
  return Object.keys(dto).some(k => WRITING_MISSION_INTERNAL_FIELDS.has(k));
}

export function findWritingMissionInternalFields(
  dto: Record<string, unknown>,
): string[] {
  return Object.keys(dto).filter(k => WRITING_MISSION_INTERNAL_FIELDS.has(k));
}
