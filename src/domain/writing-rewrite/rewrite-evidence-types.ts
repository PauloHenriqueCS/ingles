/**
 * Evidence candidate helpers for rewrite mastery tracking.
 */

import type { RewriteEvidenceType, RewriteIndependenceAssessment } from './rewrite-types';

export const ALL_REWRITE_EVIDENCE_TYPES: readonly RewriteEvidenceType[] = [
  'error_corrected_independently',
  'error_corrected_with_possible_copy',
  'valid_reformulation',
  'error_persisted',
  'new_error_introduced',
  'meaning_preserved',
  'meaning_changed',
  'cohesion_improved',
  'clarity_improved',
  'no_independent_evidence',
] as const;

/**
 * Returns true only when mastery should be positively updated.
 *
 * Positive mastery: error_corrected_independently (independent or likely_independent),
 *                   valid_reformulation (independent or likely_independent).
 * Never: no_independent_evidence, error_corrected_with_possible_copy (copied or likely_copied).
 * Neutral types: always false in Task 12.
 */
export function shouldAffectMastery(
  evidenceType: RewriteEvidenceType,
  assessment: RewriteIndependenceAssessment,
): boolean {
  if (evidenceType === 'no_independent_evidence') return false;

  if (evidenceType === 'error_corrected_with_possible_copy') {
    // Never update mastery if copy is suspected
    return false;
  }

  const isIndependent =
    assessment === 'independent' || assessment === 'likely_independent';

  if (evidenceType === 'error_corrected_independently') {
    return isIndependent;
  }

  if (evidenceType === 'valid_reformulation') {
    return isIndependent;
  }

  // Neutral types — not updating mastery in Task 12
  return false;
}

/**
 * Build a unique context key for an evidence candidate.
 * Format: `${reviewId}:${correctionId ?? 'none'}:${evidenceType}`
 */
export function buildContextKey(
  reviewId: string,
  correctionId: string | undefined,
  evidenceType: RewriteEvidenceType,
): string {
  return `${reviewId}:${correctionId ?? 'none'}:${evidenceType}`;
}
