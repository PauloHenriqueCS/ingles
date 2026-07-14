/**
 * Versioned server-side score formula for writing rewrite evaluation.
 */

import type { RewriteScoreComponents, RewriteIndependenceAssessment } from './rewrite-types';

export const CURRENT_SCORING_VERSION = 'v1';

interface ScoreWeights {
  correctionResolution: number;
  newErrorAvoidance: number;
  meaningPreservation: number;
  clarity: number;
  cohesion: number;
  independence: number;
}

const WEIGHTS_V1: ScoreWeights = {
  correctionResolution: 0.30,
  newErrorAvoidance: 0.20,
  meaningPreservation: 0.15,
  clarity: 0.15,
  cohesion: 0.10,
  independence: 0.10,
};

function getWeights(version: string): ScoreWeights {
  // Currently only v1 is supported; future versions can add here
  if (version === 'v1') return WEIGHTS_V1;
  return WEIGHTS_V1; // fallback
}

export interface ScoreCalculationInput {
  correctionResolutionScore: number;
  newErrorAvoidanceScore: number;
  meaningPreservationScore: number;
  clarityImprovementScore: number;
  cohesionImprovementScore: number;
  independenceScore: number;
  scoringVersion?: string;
}

/** Clamp a score to [0, 100] and round to nearest integer. */
export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Calculate the overall improvement score using the versioned weighted formula.
 * All inputs are clamped to 0–100 before weighting.
 * Output is clamped to 0–100.
 */
export function calculateRewriteImprovementScore(input: ScoreCalculationInput): number {
  const version = input.scoringVersion ?? CURRENT_SCORING_VERSION;
  const weights = getWeights(version);

  const weighted =
    clampScore(input.correctionResolutionScore) * weights.correctionResolution +
    clampScore(input.newErrorAvoidanceScore) * weights.newErrorAvoidance +
    clampScore(input.meaningPreservationScore) * weights.meaningPreservation +
    clampScore(input.clarityImprovementScore) * weights.clarity +
    clampScore(input.cohesionImprovementScore) * weights.cohesion +
    clampScore(input.independenceScore) * weights.independence;

  return clampScore(weighted);
}

/**
 * Returns all component scores plus the calculated overall improvement score.
 */
export function buildRewriteScoreComponents(input: ScoreCalculationInput): RewriteScoreComponents {
  return {
    correctionResolutionScore: clampScore(input.correctionResolutionScore),
    newErrorAvoidanceScore: clampScore(input.newErrorAvoidanceScore),
    meaningPreservationScore: clampScore(input.meaningPreservationScore),
    clarityImprovementScore: clampScore(input.clarityImprovementScore),
    cohesionImprovementScore: clampScore(input.cohesionImprovementScore),
    independenceScore: clampScore(input.independenceScore),
    overallImprovementScore: calculateRewriteImprovementScore(input),
  };
}

/**
 * Reduce independence score when copy is detected.
 * - copied        → 0
 * - likely_copied → raw * 0.3
 * - uncertain     → raw * 0.7
 * - otherwise     → raw
 */
export function adjustedIndependenceScore(
  raw: number,
  assessment: RewriteIndependenceAssessment,
): number {
  switch (assessment) {
    case 'copied':
      return 0;
    case 'likely_copied':
      return Math.floor(raw * 0.3);
    case 'uncertain':
      return Math.floor(raw * 0.7);
    case 'likely_independent':
    case 'independent':
    default:
      return raw;
  }
}
