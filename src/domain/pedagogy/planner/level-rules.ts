import type { CEFRLevel } from '../../curriculum/cefr';
import type { SkillAssessmentStatus } from '../../learner/learner-skill-types';
import type { PedagogicalPlanReason, MissionDifficulty } from './planner-types';
import { SAFE_FALLBACK_LEVEL, MIN_RELIABLE_CONFIDENCE } from './planner-constants';

export interface WritingProfileInput {
  level: CEFRLevel | null;
  status: SkillAssessmentStatus;
  confidence: number;
}

export interface EffectiveLevelResult {
  effectiveLevel: CEFRLevel;
  reason: PedagogicalPlanReason;
  /** True when level is not confirmed and extra conservatism applies. */
  isConservative: boolean;
  /** True when this is a temporary fallback, not a real classification. */
  isFallback: boolean;
}

/**
 * Resolves the effective writing level to use for mission planning.
 * Never returns null — always produces a safe, actionable level.
 */
export function resolveEffectiveWritingLevel(
  writingProfile: WritingProfileInput | null,
): EffectiveLevelResult {
  if (!writingProfile || writingProfile.status === 'unknown') {
    return {
      effectiveLevel: SAFE_FALLBACK_LEVEL,
      reason: 'initial_safe_fallback',
      isConservative: true,
      isFallback: true,
    };
  }

  const { level, status, confidence } = writingProfile;

  if (!level) {
    return {
      effectiveLevel: SAFE_FALLBACK_LEVEL,
      reason: 'initial_safe_fallback',
      isConservative: true,
      isFallback: true,
    };
  }

  switch (status) {
    case 'provisional':
      return {
        effectiveLevel: level,
        reason: 'provisional_level',
        isConservative: true,
        isFallback: false,
      };

    case 'calibrating':
      return {
        effectiveLevel: level,
        reason: 'ongoing_calibration',
        isConservative: confidence < MIN_RELIABLE_CONFIDENCE,
        isFallback: false,
      };

    case 'confirmed':
      return {
        effectiveLevel: level,
        reason: 'normal_progression',
        isConservative: false,
        isFallback: false,
      };

    case 'stale':
      return {
        effectiveLevel: level,
        reason: 'ongoing_calibration',
        isConservative: true,
        isFallback: false,
      };

    default:
      return {
        effectiveLevel: SAFE_FALLBACK_LEVEL,
        reason: 'initial_safe_fallback',
        isConservative: true,
        isFallback: true,
      };
  }
}

/**
 * Returns the CEFR level one step below the given level, or the same level at A1.
 * Used for conservative topic selection in provisional/stale profiles.
 */
export function conservativeLevel(level: CEFRLevel): CEFRLevel {
  const ORDER: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const idx = ORDER.indexOf(level);
  return idx <= 0 ? 'A1' : ORDER[idx - 1];
}

/**
 * Resolves the difficulty to use based on status and confidence.
 * Conservative profiles default to 'easy'; stale profiles cap at 'medium'.
 */
export function resolveSafeDifficulty(
  requested: MissionDifficulty,
  levelResult: EffectiveLevelResult,
): MissionDifficulty {
  if (levelResult.isFallback) return 'easy';
  if (levelResult.reason === 'provisional_level') {
    return requested === 'hard' ? 'medium' : requested;
  }
  return requested;
}
