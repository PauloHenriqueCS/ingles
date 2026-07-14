/**
 * Outcome types and status determination helpers for rewrite correction outcomes.
 */

import type { RewriteCorrectionOutcomeStatus } from './rewrite-types';

/**
 * Map from AI model output string to canonical outcome status.
 * Accepts common variants and aliases.
 */
export function parseOutcomeStatus(raw: string): RewriteCorrectionOutcomeStatus {
  const normalized = raw.trim().toLowerCase();

  switch (normalized) {
    case 'corrected':
      return 'corrected';
    case 'partially_corrected':
    case 'partial':
      return 'partially_corrected';
    case 'unchanged':
      return 'unchanged';
    case 'valid_alternative':
    case 'alternative':
      return 'valid_alternative';
    case 'worsened':
      return 'worsened';
    case 'not_applicable':
    case 'na':
      return 'not_applicable';
    default:
      throw new Error(`Unrecognized correction outcome status: "${raw}"`);
  }
}

/**
 * Returns true when the error was addressed by the learner.
 * True for: corrected, valid_alternative
 */
export function outcomeIsResolved(status: RewriteCorrectionOutcomeStatus): boolean {
  return status === 'corrected' || status === 'valid_alternative';
}

/**
 * Returns true when this outcome should contribute positively
 * to the correction resolution score.
 */
export function outcomeContributesToCorrectionResolution(
  status: RewriteCorrectionOutcomeStatus,
  shouldAffectScore: boolean,
): boolean {
  if (!shouldAffectScore) return false;
  return outcomeIsResolved(status);
}

/**
 * Calculate correction resolution score from a list of outcomes.
 * Denominator excludes 'not_applicable' outcomes.
 * Returns 0 if no applicable outcomes.
 */
export function calculateCorrectionResolutionScore(
  outcomes: Array<{ status: RewriteCorrectionOutcomeStatus; shouldAffectRewriteScore: boolean }>,
): number {
  const applicable = outcomes.filter(o => o.status !== 'not_applicable');
  if (applicable.length === 0) return 0;

  const resolved = applicable.filter(o =>
    outcomeContributesToCorrectionResolution(o.status, o.shouldAffectRewriteScore),
  ).length;

  return Math.round((resolved / applicable.length) * 100);
}
