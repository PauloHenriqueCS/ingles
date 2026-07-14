import { CEFRLevel, ALL_CEFR_LEVELS } from '../curriculum/cefr';
import { LearningSkill, LEARNING_SKILLS, SkillAssessmentStatus, SKILL_ASSESSMENT_STATUSES, SkillLevelSource, SKILL_LEVEL_SOURCES } from './learner-skill-types';
import { GrammarMasteryState, GRAMMAR_MASTERY_STATES } from './grammar-mastery-types';

const CEFR_SET = new Set<string>(ALL_CEFR_LEVELS as CEFRLevel[]);
const SKILL_SET = new Set<string>(LEARNING_SKILLS as LearningSkill[]);
const STATUS_SET = new Set<string>(SKILL_ASSESSMENT_STATUSES as SkillAssessmentStatus[]);
const SOURCE_SET = new Set<string>(SKILL_LEVEL_SOURCES as SkillLevelSource[]);
const MASTERY_STATE_SET = new Set<string>(GRAMMAR_MASTERY_STATES as GrammarMasteryState[]);

export function validateConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`Confidence must be between 0 and 1, got: ${value}`);
  }
}

export function validateCefrLevel(value: string | null): void {
  if (value !== null && !CEFR_SET.has(value)) {
    throw new TypeError(`Invalid CEFR level: "${value}"`);
  }
}

export function validateLearningSkill(value: string): void {
  if (!SKILL_SET.has(value)) {
    throw new TypeError(`Invalid learning skill: "${value}"`);
  }
}

export function validateSkillAssessmentStatus(value: string): void {
  if (!STATUS_SET.has(value)) {
    throw new TypeError(`Invalid skill assessment status: "${value}"`);
  }
}

export function validateSkillLevelSource(value: string): void {
  if (!SOURCE_SET.has(value)) {
    throw new TypeError(`Invalid skill level source: "${value}"`);
  }
}

export function validateGrammarMasteryState(value: string): void {
  if (!MASTERY_STATE_SET.has(value)) {
    throw new TypeError(`Invalid grammar mastery state: "${value}"`);
  }
}

export function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got: ${value}`);
  }
}

export function validateGrammarMasteryCounters(params: {
  totalOpportunities: number;
  successfulUses: number;
  errorCount: number;
  independentUses: number;
  guidedUses: number;
  assistedUses: number;
}): void {
  const { totalOpportunities, successfulUses, errorCount, independentUses, guidedUses, assistedUses } = params;

  validateNonNegativeInteger(totalOpportunities, 'totalOpportunities');
  validateNonNegativeInteger(successfulUses, 'successfulUses');
  validateNonNegativeInteger(errorCount, 'errorCount');
  validateNonNegativeInteger(independentUses, 'independentUses');
  validateNonNegativeInteger(guidedUses, 'guidedUses');
  validateNonNegativeInteger(assistedUses, 'assistedUses');

  if (successfulUses > totalOpportunities) {
    throw new RangeError(
      `successfulUses (${successfulUses}) cannot exceed totalOpportunities (${totalOpportunities})`
    );
  }

  // independentUses + guidedUses + assistedUses <= totalOpportunities porque
  // nem toda oportunidade necessariamente gera uso explicitamente categorizado.
  const totalTypedUses = independentUses + guidedUses + assistedUses;
  if (totalTypedUses > totalOpportunities) {
    throw new RangeError(
      `Sum of use types (${totalTypedUses}) cannot exceed totalOpportunities (${totalOpportunities})`
    );
  }
}
