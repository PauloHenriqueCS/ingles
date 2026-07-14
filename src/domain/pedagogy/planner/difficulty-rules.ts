import type { CEFRLevel } from '../../curriculum/cefr';
import type { MissionDifficulty, MissionSupportLevel } from './planner-types';

export interface DifficultyProfile {
  /** Number of conflicts/elements in the narrative. */
  narrativeElements: 1 | 2 | 3;
  /** Whether a decision is required (not just description). */
  requiresDecision: boolean;
  /** Whether consequence linking is expected. */
  requiresConsequenceLink: boolean;
  /** Default support level when no other rule overrides. */
  defaultSupportLevel: MissionSupportLevel;
  /** Number of secondary objectives allowed. */
  maxSecondaryObjectives: 1 | 2 | 3;
  /** Whether complex narrative structure is permitted. */
  allowComplexNarrative: boolean;
  /** Maximum suggested text length guidance. */
  suggestedLengthWords: { min: number; max: number };
}

const DIFFICULTY_PROFILES: Record<CEFRLevel, Record<MissionDifficulty, DifficultyProfile>> = {
  A1: {
    easy: {
      narrativeElements: 1,
      requiresDecision: false,
      requiresConsequenceLink: false,
      defaultSupportLevel: 'high',
      maxSecondaryObjectives: 1,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 20, max: 50 },
    },
    medium: {
      narrativeElements: 1,
      requiresDecision: true,
      requiresConsequenceLink: false,
      defaultSupportLevel: 'high',
      maxSecondaryObjectives: 1,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 30, max: 70 },
    },
    hard: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'standard',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 40, max: 80 },
    },
  },
  A2: {
    easy: {
      narrativeElements: 1,
      requiresDecision: true,
      requiresConsequenceLink: false,
      defaultSupportLevel: 'standard',
      maxSecondaryObjectives: 1,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 40, max: 80 },
    },
    medium: {
      narrativeElements: 1,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'standard',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 60, max: 100 },
    },
    hard: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'standard',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 70, max: 120 },
    },
  },
  B1: {
    easy: {
      narrativeElements: 1,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'standard',
      maxSecondaryObjectives: 1,
      allowComplexNarrative: false,
      suggestedLengthWords: { min: 60, max: 110 },
    },
    medium: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'standard',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 80, max: 140 },
    },
    hard: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 100, max: 160 },
    },
  },
  B2: {
    easy: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 100, max: 160 },
    },
    medium: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 120, max: 200 },
    },
    hard: {
      narrativeElements: 3,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 3,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 150, max: 250 },
    },
  },
  C1: {
    easy: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 150, max: 220 },
    },
    medium: {
      narrativeElements: 3,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 3,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 180, max: 280 },
    },
    hard: {
      narrativeElements: 3,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 3,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 200, max: 320 },
    },
  },
  C2: {
    easy: {
      narrativeElements: 2,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 2,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 180, max: 280 },
    },
    medium: {
      narrativeElements: 3,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 3,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 220, max: 350 },
    },
    hard: {
      narrativeElements: 3,
      requiresDecision: true,
      requiresConsequenceLink: true,
      defaultSupportLevel: 'minimal',
      maxSecondaryObjectives: 3,
      allowComplexNarrative: true,
      suggestedLengthWords: { min: 250, max: 400 },
    },
  },
};

export function getDifficultyProfile(
  level: CEFRLevel,
  difficulty: MissionDifficulty,
): DifficultyProfile {
  return DIFFICULTY_PROFILES[level][difficulty];
}
