import type { CEFRLevel } from '../../curriculum/cefr';
import type { GrammarMasteryState } from '../../learner/grammar-mastery-types';
import type { SkillAssessmentStatus } from '../../learner/learner-skill-types';
import type { MissionDifficulty, MissionSupportLevel, MissionSupportConfiguration } from './planner-types';
import { MIN_RELIABLE_CONFIDENCE } from './planner-constants';

export interface SupportInput {
  level: CEFRLevel;
  difficulty: MissionDifficulty;
  assessmentStatus: SkillAssessmentStatus;
  confidence: number;
  primaryTopicStates: GrammarMasteryState[];
  hasRecentStruggleSignals: boolean;
}

const LEVEL_DEFAULT_SUPPORT: Record<CEFRLevel, MissionSupportLevel> = {
  A1: 'high',
  A2: 'standard',
  B1: 'standard',
  B2: 'minimal',
  C1: 'minimal',
  C2: 'minimal',
};


export function resolveMissionSupportLevel(input: SupportInput): MissionSupportLevel {
  let level: MissionSupportLevel = LEVEL_DEFAULT_SUPPORT[input.level];

  // Difficulty easy always raises to high
  if (input.difficulty === 'easy' && level !== 'high') {
    level = 'high';
  }

  // Low confidence → raise support
  if (input.confidence < MIN_RELIABLE_CONFIDENCE) {
    level = 'high';
  }

  // Recent struggle signals → raise support
  if (input.hasRecentStruggleSignals) {
    if (level === 'minimal') level = 'standard';
    else if (level === 'standard') level = 'high';
  }

  // Provisional/stale → at least standard
  if ((input.assessmentStatus === 'provisional' || input.assessmentStatus === 'stale') && level === 'minimal') {
    level = 'standard';
  }

  // Primary topic in introducing state → raise support
  const hasPrimaryIntroduced = input.primaryTopicStates.some(s => s === 'introduced');
  if (hasPrimaryIntroduced && level === 'minimal') {
    level = 'standard';
  }

  // Primary topic consolidating → may reduce support
  const allPrimaryConsolidatingOrBetter = input.primaryTopicStates.every(
    s => s === 'consolidating' || s === 'mastered' || s === 'maintenance',
  );
  if (allPrimaryConsolidatingOrBetter && input.difficulty === 'hard' && level === 'standard') {
    level = 'minimal';
  }

  return level;
}

export function resolveMissionSupportConfiguration(
  input: SupportInput,
): { supportLevel: MissionSupportLevel; supportConfiguration: MissionSupportConfiguration } {
  const supportLevel = resolveMissionSupportLevel(input);

  const config: MissionSupportConfiguration = {
    showPortugueseIdeaField: supportLevel === 'high' || input.level === 'A1' || input.level === 'A2',
    allowSuggestedWords: supportLevel !== 'minimal',
    allowSupportSentences: supportLevel === 'high',
    allowGrammarExplanation: supportLevel !== 'minimal',
    autoRevealSupport: supportLevel === 'high' && (input.level === 'A1'),
    maximumSupportSentences: supportLevel === 'high' ? 3 : supportLevel === 'standard' ? 2 : 0,
  };

  return { supportLevel, supportConfiguration: config };
}
