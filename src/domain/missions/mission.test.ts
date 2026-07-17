/**
 * Task 10 — Mission generation integration tests
 * 75 mandatory tests covering:
 * - Rejection codes (3)
 * - Mission validator structural checks (10)
 * - Mission validator communicative purpose (8)
 * - Mission validator level compliance (8)
 * - Mission validator grammar compliance (8)
 * - Mission validator conflict/constraint checks (3)
 * - Mission DTO (6)
 * - Mission fallback templates (11)
 * - Generator feature flags (14)
 * - Mission prompt builder (4)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ALL_MISSION_REJECTION_CODES } from './mission-rejection-codes';
import {
  validateMissionAgainstPedagogicalPlan,
  validateMissionStructure,
} from './mission-validator';
import {
  toPublicWritingMissionDTO,
  containsWritingMissionInternalFields,
  findWritingMissionInternalFields,
} from './mission-dto';
import {
  FALLBACK_TEMPLATES,
  getFallbackTemplate,
  selectFallbackTemplate,
  buildFallbackCandidate,
} from './mission-fallback';
import {
  getGeneratorIntegrationMode,
  isGeneratorIntegrationEnabled,
  isGeneratorIntegrationInShadowMode,
  isGeneratorIntegrationFullyActive,
  getMissionValidatorMode,
  isMissionValidatorActive,
  isMissionValidatorEnforcing,
} from '../../../api/_mission-generator-feature-flags';
import {
  buildPlanConstraintsSection,
  buildRepairSection,
} from '../../../api/_mission-prompt-builder';
import type { MissionPedagogicalPlan } from '../pedagogy/planner/planner-types';
import type { GeneratedMissionCandidate } from './mission-generation-types';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<MissionPedagogicalPlan> = {}): MissionPedagogicalPlan {
  return {
    id: 'plan-test-001',
    version: 1,
    userId: 'user-abc',
    skill: 'writing',
    catalogVersion: 1,
    plannerVersion: 'v1',
    learnerLevel: 'A2',
    effectiveLevel: 'A2',
    assessmentStatus: 'confirmed',
    assessmentConfidence: 0.85,
    mode: 'normal',
    difficulty: 'medium',
    reason: 'normal_progression',
    communicativeObjectiveId: 'obj.a2.recount_event',
    communicativeFunctions: ['Narrar um evento passado com consequências'],
    grammarTopics: [],
    vocabularyItems: [],
    prerequisitesSatisfied: [],
    prerequisitesMissing: [],
    supportLevel: 'standard',
    supportConfiguration: {
      showPortugueseIdeaField: true,
      allowSuggestedWords: true,
      allowSupportSentences: false,
      allowGrammarExplanation: false,
      autoRevealSupport: false,
      maximumSupportSentences: 3,
    },
    noveltyBudget: { maximumNewGrammarTopics: 1, maximumNewVocabularyItems: 4 },
    recoveryBudget: { maximumGrammarReviewTopics: 1, maximumVocabularyReviewItems: 2 },
    generationConstraints: {
      requireEverydaySituation: true,
      requireConflictDecisionOrUnexpectedEvent: false,
      avoidGenericTopic: true,
      avoidExplicitGrammarExercise: true,
      forbiddenRequiredTopicIds: [],
      forbiddenInstructions: [],
      preferredContextFamilies: ['workplace_issue', 'travel_disruption'],
      avoidedContextFamilies: [],
    },
    validationRules: {
      requiredTopicCoverage: [],
      forbiddenRequiredTopicIds: [],
      maximumEstimatedLevel: 'A2',
      allowIncidentalAdvancedLanguage: true,
    },
    seed: 'seed-xyz',
    createdAt: '2026-07-14T00:00:00.000Z',
    acceptedAt: null,
    supersededAt: null,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<GeneratedMissionCandidate> = {}): GeneratedMissionCandidate {
  return {
    title: 'Mensagem para o colega',
    missionSetup: 'Seu colega está com dificuldades em um projeto de trabalho.',
    missionTask: 'Escreva uma mensagem explicando como você resolveu um problema parecido.',
    mission: 'Seu colega está com dificuldades em um projeto. Escreva uma mensagem explicando como resolver.',
    themePtBr: 'Seu colega está com dificuldades em um projeto.',
    themeEn: 'Write a message explaining how you solved a similar problem.',
    format: 'mensagem',
    context: 'trabalho',
    conflict: 'precisou ajudar',
    objective: 'explicar',
    activityType: 'mensagem',
    semanticSummary: 'Formato: mensagem | Conflito: precisou ajudar | Objetivo: explicar',
    whyThisActivity: 'Prática de comunicação no trabalho.',
    level: 'A2',
    difficulty: 'medium',
    estimatedTimeMinutes: 15,
    requiredGrammar: ['simple past'],
    suggestedVocabulary: [],
    useTheseWords: [],
    instructions: ['Explain the problem', 'Describe the solution'],
    exampleSentence: 'I fixed the bug by rewriting the function.',
    successCriteria: ['Clear explanation', 'Correct past tense'],
    extraChallenge: '',
    category: 'work',
    grammarTips: {},
    responseExamples: [],
    ...overrides,
  };
}

// ── 1. Mission Rejection Codes ────────────────────────────────────────────────

describe('Mission Rejection Codes', () => {
  it('has exactly 25 canonical rejection codes', () => {
    expect(ALL_MISSION_REJECTION_CODES).toHaveLength(25);
  });

  it('contains no duplicates', () => {
    const set = new Set(ALL_MISSION_REJECTION_CODES);
    expect(set.size).toBe(ALL_MISSION_REJECTION_CODES.length);
  });

  it('every entry is a non-empty string', () => {
    for (const code of ALL_MISSION_REJECTION_CODES) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});

// ── 2. Mission Validator — structural checks ───────────────────────────────────

describe('Mission Validator — structural checks', () => {
  it('rejects a missing title', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ title: '' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_TITLE');
  });

  it('rejects a whitespace-only title', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ title: '   ' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_TITLE');
  });

  it('rejects a missing missionSetup', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: '' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_MISSION_SETUP');
  });

  it('rejects a missing missionTask', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionTask: '' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_MISSION_TASK');
  });

  it('rejects an invalid level field', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'Z9' as any }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_LEVEL_FIELD');
  });

  it('rejects an empty level field', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: '' as any }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_LEVEL_FIELD');
  });

  it('rejects an invalid difficulty field', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ difficulty: 'extreme' as any }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('INVALID_DIFFICULTY_FIELD');
  });

  it('accepts all valid difficulty values', () => {
    for (const diff of ['easy', 'medium', 'hard'] as const) {
      const result = validateMissionAgainstPedagogicalPlan(
        makeCandidate({ difficulty: diff }),
        makePlan(),
      );
      expect(result.rejectionCode).not.toBe('INVALID_DIFFICULTY_FIELD');
    }
  });

  it('accepts a structurally valid candidate', () => {
    const result = validateMissionAgainstPedagogicalPlan(makeCandidate(), makePlan());
    expect(result.valid).toBe(true);
  });

  it('validateMissionStructure returns false for non-object', () => {
    expect(validateMissionStructure(null)).toBe(false);
    expect(validateMissionStructure('string')).toBe(false);
    expect(validateMissionStructure(42)).toBe(false);
  });
});

// ── 3. Mission Validator — communicative purpose ───────────────────────────────

describe('Mission Validator — communicative purpose', () => {
  it('rejects setup starting with "Escreva"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Escreva sobre sua semana no trabalho.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('rejects setup starting with "Conte"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Conte sobre sua viagem.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('rejects setup starting with "Descreva"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Descreva seu restaurante favorito.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('rejects setup starting with "Write"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Write an email about your project.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('rejects setup starting with "Fale sobre"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Fale sobre sua experiência no trabalho.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('accepts setup that starts with "Você"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Você perdeu o voo e precisa avisar seu hotel.' }),
      makePlan(),
    );
    expect(result.rejectionCode).not.toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('accepts setup that starts with "Seu"', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Seu gerente pediu uma proposta urgente.' }),
      makePlan(),
    );
    expect(result.rejectionCode).not.toBe('SETUP_STARTS_WITH_WRITE');
  });

  it('rejects when missionSetup is too short to have communicative purpose', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Situação.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('NO_COMMUNICATIVE_PURPOSE');
  });
});

// ── 4. Mission Validator — level compliance ────────────────────────────────────

describe('Mission Validator — level compliance', () => {
  it('accepts mission at the planned level (A2 → A2)', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'A2' }),
      makePlan({ effectiveLevel: 'A2', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'A2', allowIncidentalAdvancedLanguage: true } }),
    );
    expect(result.valid).toBe(true);
    expect(result.rejectionCode).toBeNull();
  });

  it('accepts mission one level below planned level (A1 for A2 plan)', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'A1' }),
      makePlan({ effectiveLevel: 'A2', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'A2', allowIncidentalAdvancedLanguage: true } }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects mission one level above the planned maximum (B1 for A2 plan)', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'B1' }),
      makePlan({ effectiveLevel: 'A2', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'A2', allowIncidentalAdvancedLanguage: true } }),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('LEVEL_TOO_HIGH');
  });

  it('rejects C2 mission for A1 plan', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'C2' }),
      makePlan({ effectiveLevel: 'A1', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'A1', allowIncidentalAdvancedLanguage: true } }),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('LEVEL_TOO_HIGH');
  });

  it('accepts C2 mission for C2 plan', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'C2' }),
      makePlan({ effectiveLevel: 'C2', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'C2', allowIncidentalAdvancedLanguage: true } }),
    );
    expect(result.valid).toBe(true);
  });

  it('adds LEVEL_MISMATCH warning when mission is below plan', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'A1' }),
      makePlan({ effectiveLevel: 'B2', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'B2', allowIncidentalAdvancedLanguage: true } }),
    );
    expect(result.valid).toBe(true);
    const levelWarning = result.warnings.find(w => w.code === 'LEVEL_MISMATCH');
    expect(levelWarning).toBeDefined();
  });

  it('does not add LEVEL_MISMATCH when mission matches plan exactly', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'B1' }),
      makePlan({ effectiveLevel: 'B1', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'B1', allowIncidentalAdvancedLanguage: true } }),
    );
    const levelWarning = result.warnings.find(w => w.code === 'LEVEL_MISMATCH');
    expect(levelWarning).toBeUndefined();
  });

  it('rejects B2 mission for B1 plan', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ level: 'B2' }),
      makePlan({ effectiveLevel: 'B1', validationRules: { requiredTopicCoverage: [], forbiddenRequiredTopicIds: [], maximumEstimatedLevel: 'B1', allowIncidentalAdvancedLanguage: false } }),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('LEVEL_TOO_HIGH');
  });
});

// ── 5. Mission Validator — grammar compliance ──────────────────────────────────

describe('Mission Validator — grammar compliance', () => {
  it('rejects when a forbidden topic is in requiredGrammar', () => {
    const plan = makePlan({
      generationConstraints: {
        requireEverydaySituation: true,
        requireConflictDecisionOrUnexpectedEvent: false,
        avoidGenericTopic: true,
        avoidExplicitGrammarExercise: true,
        forbiddenRequiredTopicIds: ['grammar.subjunctive'],
        forbiddenInstructions: ['Do not require use of Subjunctive Mood'],
        preferredContextFamilies: [],
        avoidedContextFamilies: [],
      },
    });

    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ requiredGrammar: ['Subjunctive Mood'] }),
      plan,
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('FORBIDDEN_GRAMMAR_REQUIRED');
  });

  it('does not reject when requiredGrammar does not contain forbidden topic', () => {
    const plan = makePlan({
      generationConstraints: {
        requireEverydaySituation: true,
        requireConflictDecisionOrUnexpectedEvent: false,
        avoidGenericTopic: true,
        avoidExplicitGrammarExercise: true,
        forbiddenRequiredTopicIds: ['grammar.subjunctive'],
        forbiddenInstructions: ['Do not require use of Subjunctive Mood'],
        preferredContextFamilies: [],
        avoidedContextFamilies: [],
      },
    });

    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ requiredGrammar: ['simple past', 'present perfect'] }),
      plan,
    );
    expect(result.valid).toBe(true);
  });

  it('accepts empty requiredGrammar', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ requiredGrammar: [] }),
      makePlan(),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects when setup contains explicit grammar exercise phrase', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ missionSetup: 'Seu chefe pediu uma explicação. Use o Present Perfect para responder.' }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('EXPLICIT_GRAMMAR_EXERCISE');
  });

  it('rejects when instructions contain explicit grammar exercise phrase', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ instructions: ['Practice the passive voice in every sentence.'] }),
      makePlan(),
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('EXPLICIT_GRAMMAR_EXERCISE');
  });

  it('adds GRAMMAR_TOPIC_NAME_EXPOSED warning when grammar name appears in mission text', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({
        missionSetup: 'Você está praticando simple past com seu professor.',
        requiredGrammar: ['simple past'],
      }),
      makePlan(),
    );
    const warning = result.warnings.find(w => w.code === 'GRAMMAR_TOPIC_NAME_EXPOSED');
    expect(warning).toBeDefined();
  });

  it('does not add GRAMMAR_TOPIC_NAME_EXPOSED for very short grammar items', () => {
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({
        missionSetup: 'Você foi ao mercado e perdeu seu celular.',
        requiredGrammar: ['to be'],
      }),
      makePlan(),
    );
    const warning = result.warnings.find(w => w.code === 'GRAMMAR_TOPIC_NAME_EXPOSED');
    expect(warning).toBeUndefined();
  });

  it('handles multiple forbidden instructions correctly', () => {
    const plan = makePlan({
      generationConstraints: {
        requireEverydaySituation: true,
        requireConflictDecisionOrUnexpectedEvent: false,
        avoidGenericTopic: true,
        avoidExplicitGrammarExercise: true,
        forbiddenRequiredTopicIds: ['grammar.a', 'grammar.b'],
        forbiddenInstructions: [
          'Do not require use of Conditional Sentences',
          'Do not require use of Passive Voice',
          'Do not ask the student to demonstrate a specific grammar structure explicitly',
        ],
        preferredContextFamilies: [],
        avoidedContextFamilies: [],
      },
    });

    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ requiredGrammar: ['Passive Voice'] }),
      plan,
    );
    expect(result.valid).toBe(false);
    expect(result.rejectionCode).toBe('FORBIDDEN_GRAMMAR_REQUIRED');
  });
});

// ── 6. Mission Validator — conflict/constraint checks ─────────────────────────

describe('Mission Validator — conflict and constraint checks', () => {
  it('does not warn about missing conflict when conflict is not required by plan', () => {
    const plan = makePlan({
      generationConstraints: {
        requireEverydaySituation: true,
        requireConflictDecisionOrUnexpectedEvent: false,
        avoidGenericTopic: true,
        avoidExplicitGrammarExercise: true,
        forbiddenRequiredTopicIds: [],
        forbiddenInstructions: [],
        preferredContextFamilies: [],
        avoidedContextFamilies: [],
      },
    });
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ conflict: '' }),
      plan,
    );
    const conflictWarning = result.warnings.find(w => w.code === 'MISSING_CONFLICT_OR_DECISION');
    expect(conflictWarning).toBeUndefined();
  });

  it('warns about missing conflict when plan requires it and none detected', () => {
    const plan = makePlan({
      generationConstraints: {
        requireEverydaySituation: true,
        requireConflictDecisionOrUnexpectedEvent: true,
        avoidGenericTopic: true,
        avoidExplicitGrammarExercise: true,
        forbiddenRequiredTopicIds: [],
        forbiddenInstructions: [],
        preferredContextFamilies: [],
        avoidedContextFamilies: [],
      },
    });
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({
        conflict: '',
        missionSetup: 'Seu amigo quer aprender inglês junto com você.',
        missionTask: 'Escreva uma mensagem de apresentação para ele.',
      }),
      plan,
    );
    const conflictWarning = result.warnings.find(w => w.code === 'MISSING_CONFLICT_OR_DECISION');
    expect(conflictWarning).toBeDefined();
  });

  it('does not warn when conflict field has content and plan requires conflict', () => {
    const plan = makePlan({
      generationConstraints: {
        requireEverydaySituation: true,
        requireConflictDecisionOrUnexpectedEvent: true,
        avoidGenericTopic: true,
        avoidExplicitGrammarExercise: true,
        forbiddenRequiredTopicIds: [],
        forbiddenInstructions: [],
        preferredContextFamilies: [],
        avoidedContextFamilies: [],
      },
    });
    const result = validateMissionAgainstPedagogicalPlan(
      makeCandidate({ conflict: 'perdeu o voo' }),
      plan,
    );
    const conflictWarning = result.warnings.find(w => w.code === 'MISSING_CONFLICT_OR_DECISION');
    expect(conflictWarning).toBeUndefined();
  });
});

// ── 7. Mission DTO ─────────────────────────────────────────────────────────────

describe('Mission DTO — toPublicWritingMissionDTO', () => {
  it('strips pedagogicalPlanId from output', () => {
    const internal = makeCandidate({ pedagogicalPlanId: 'plan-secret-id' });
    const dto = toPublicWritingMissionDTO(internal);
    expect((dto as any).pedagogicalPlanId).toBeUndefined();
  });

  it('strips validationPassed from output', () => {
    const internal = makeCandidate({ validationPassed: true });
    const dto = toPublicWritingMissionDTO(internal);
    expect((dto as any).validationPassed).toBeUndefined();
  });

  it('strips validationWarnings from output', () => {
    const internal = makeCandidate({ validationWarnings: ['some warning'] });
    const dto = toPublicWritingMissionDTO(internal);
    expect((dto as any).validationWarnings).toBeUndefined();
  });

  it('preserves all public fields', () => {
    const internal = makeCandidate();
    const dto = toPublicWritingMissionDTO(internal);
    expect(dto.title).toBe(internal.title);
    expect(dto.missionSetup).toBe(internal.missionSetup);
    expect(dto.level).toBe(internal.level);
    expect(dto.difficulty).toBe(internal.difficulty);
  });

  it('containsWritingMissionInternalFields returns true when internal fields are present', () => {
    const obj = { title: 'Test', pedagogicalPlanId: 'secret' };
    expect(containsWritingMissionInternalFields(obj)).toBe(true);
  });

  it('findWritingMissionInternalFields returns names of internal fields found', () => {
    const obj = { title: 'Test', pedagogicalPlanId: 'secret', validationPassed: true };
    const found = findWritingMissionInternalFields(obj);
    expect(found).toContain('pedagogicalPlanId');
    expect(found).toContain('validationPassed');
    expect(found).not.toContain('title');
  });
});

// ── 8. Mission Fallback Templates ──────────────────────────────────────────────

describe('Mission Fallback Templates', () => {
  it('has exactly 10 fallback templates', () => {
    expect(FALLBACK_TEMPLATES).toHaveLength(10);
  });

  it('each template has a unique id', () => {
    const ids = FALLBACK_TEMPLATES.map(t => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('each template has all required string fields', () => {
    for (const template of FALLBACK_TEMPLATES) {
      expect(typeof template.title).toBe('string');
      expect(typeof template.missionSetup).toBe('string');
      expect(typeof template.missionTask).toBe('string');
      expect(typeof template.format).toBe('string');
      expect(typeof template.context).toBe('string');
      expect(typeof template.conflict).toBe('string');
      expect(typeof template.objective).toBe('string');
    }
  });

  it('each template has requiredGrammar for all 6 CEFR levels', () => {
    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
    for (const template of FALLBACK_TEMPLATES) {
      for (const level of levels) {
        expect(Array.isArray(template.requiredGrammar[level])).toBe(true);
        expect(template.requiredGrammar[level].length).toBeGreaterThan(0);
      }
    }
  });

  it('each template has non-empty instructions and successCriteria', () => {
    for (const template of FALLBACK_TEMPLATES) {
      expect(template.instructions.length).toBeGreaterThan(0);
      expect(template.successCriteria.length).toBeGreaterThan(0);
    }
  });

  it('getFallbackTemplate returns template by id', () => {
    const first = FALLBACK_TEMPLATES[0];
    const found = getFallbackTemplate(first.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(first.id);
  });

  it('getFallbackTemplate returns undefined for unknown id', () => {
    expect(getFallbackTemplate('fallback.unknown')).toBeUndefined();
  });

  it('selectFallbackTemplate returns a valid template', () => {
    const result = selectFallbackTemplate('A2', 'medium');
    expect(result).toBeDefined();
    expect(typeof result.id).toBe('string');
  });

  it('selectFallbackTemplate avoids previousTemplateId when alternatives exist', () => {
    const first = selectFallbackTemplate('A1', 'easy');
    const second = selectFallbackTemplate('A1', 'easy', first.id);
    expect(second.id).not.toBe(first.id);
  });

  it('selectFallbackTemplate is deterministic for same inputs', () => {
    const a = selectFallbackTemplate('B1', 'hard');
    const b = selectFallbackTemplate('B1', 'hard');
    expect(a.id).toBe(b.id);
  });

  it('buildFallbackCandidate uses level-appropriate grammar', () => {
    const template = FALLBACK_TEMPLATES[0];
    const candidateA1 = buildFallbackCandidate(template, 'A1');
    const candidateB2 = buildFallbackCandidate(template, 'B2');
    expect(candidateA1.requiredGrammar).not.toEqual(candidateB2.requiredGrammar);
  });

  it('buildFallbackCandidate sets level to the requested level', () => {
    const template = FALLBACK_TEMPLATES[0];
    const candidate = buildFallbackCandidate(template, 'B1');
    expect(candidate.level).toBe('B1');
  });
});

// ── 9. Generator Feature Flags ─────────────────────────────────────────────────

describe('Generator Feature Flags — PEDAGOGICAL_GENERATOR_INTEGRATION_V1', () => {
  let orig: string | undefined;
  let origEngineVersion: string | undefined;

  beforeEach(() => {
    orig = process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1;
    origEngineVersion = process.env.LEARNING_ENGINE_VERSION;
    process.env.LEARNING_ENGINE_VERSION = 'v1';
  });

  afterEach(() => {
    if (orig !== undefined) {
      process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = orig;
    } else {
      delete process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1;
    }
    if (origEngineVersion === undefined) {
      delete process.env.LEARNING_ENGINE_VERSION;
    } else {
      process.env.LEARNING_ENGINE_VERSION = origEngineVersion;
    }
  });

  it('returns "off" when env var is not set', () => {
    delete process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1;
    expect(getGeneratorIntegrationMode()).toBe('off');
  });

  it('returns "shadow" when env=shadow', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'shadow';
    expect(getGeneratorIntegrationMode()).toBe('shadow');
  });

  it('returns "enabled" when env=true', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'true';
    expect(getGeneratorIntegrationMode()).toBe('enabled');
  });

  it('returns "enabled" when env=1', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = '1';
    expect(getGeneratorIntegrationMode()).toBe('enabled');
  });

  it('returns "enabled" when env=enabled', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'enabled';
    expect(getGeneratorIntegrationMode()).toBe('enabled');
  });

  it('returns "off" for unknown values', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'maybe';
    expect(getGeneratorIntegrationMode()).toBe('off');
  });

  it('isGeneratorIntegrationEnabled=false when off', () => {
    delete process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1;
    expect(isGeneratorIntegrationEnabled()).toBe(false);
  });

  it('isGeneratorIntegrationEnabled=true when shadow', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'shadow';
    expect(isGeneratorIntegrationEnabled()).toBe(true);
  });

  it('isGeneratorIntegrationEnabled=true when enabled', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'enabled';
    expect(isGeneratorIntegrationEnabled()).toBe(true);
  });

  it('isGeneratorIntegrationInShadowMode=true only when shadow', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'shadow';
    expect(isGeneratorIntegrationInShadowMode()).toBe(true);
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'enabled';
    expect(isGeneratorIntegrationInShadowMode()).toBe(false);
  });

  it('isGeneratorIntegrationFullyActive=true only when enabled', () => {
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'enabled';
    expect(isGeneratorIntegrationFullyActive()).toBe(true);
    process.env.PEDAGOGICAL_GENERATOR_INTEGRATION_V1 = 'shadow';
    expect(isGeneratorIntegrationFullyActive()).toBe(false);
  });
});

describe('Generator Feature Flags — MISSION_VALIDATOR_V1', () => {
  let orig: string | undefined;
  let origEngineVersion: string | undefined;

  beforeEach(() => {
    orig = process.env.MISSION_VALIDATOR_V1;
    origEngineVersion = process.env.LEARNING_ENGINE_VERSION;
    process.env.LEARNING_ENGINE_VERSION = 'v1';
  });

  afterEach(() => {
    if (orig !== undefined) {
      process.env.MISSION_VALIDATOR_V1 = orig;
    } else {
      delete process.env.MISSION_VALIDATOR_V1;
    }
    if (origEngineVersion === undefined) {
      delete process.env.LEARNING_ENGINE_VERSION;
    } else {
      process.env.LEARNING_ENGINE_VERSION = origEngineVersion;
    }
  });

  it('returns "off" when env not set', () => {
    delete process.env.MISSION_VALIDATOR_V1;
    expect(getMissionValidatorMode()).toBe('off');
  });

  it('returns "warn" when env=warn', () => {
    process.env.MISSION_VALIDATOR_V1 = 'warn';
    expect(getMissionValidatorMode()).toBe('warn');
  });

  it('returns "enforce" when env=enforce', () => {
    process.env.MISSION_VALIDATOR_V1 = 'enforce';
    expect(getMissionValidatorMode()).toBe('enforce');
  });

  it('isMissionValidatorActive=false when off', () => {
    delete process.env.MISSION_VALIDATOR_V1;
    expect(isMissionValidatorActive()).toBe(false);
  });

  it('isMissionValidatorActive=true when warn', () => {
    process.env.MISSION_VALIDATOR_V1 = 'warn';
    expect(isMissionValidatorActive()).toBe(true);
  });

  it('isMissionValidatorEnforcing=true only when enforce', () => {
    process.env.MISSION_VALIDATOR_V1 = 'enforce';
    expect(isMissionValidatorEnforcing()).toBe(true);
    process.env.MISSION_VALIDATOR_V1 = 'warn';
    expect(isMissionValidatorEnforcing()).toBe(false);
  });
});

// ── 10. Mission Prompt Builder ─────────────────────────────────────────────────

describe('Mission Prompt Builder', () => {
  const plan = makePlan({
    effectiveLevel: 'B1',
    difficulty: 'medium',
    communicativeFunctions: ['Narrar uma experiência com consequências'],
    generationConstraints: {
      requireEverydaySituation: true,
      requireConflictDecisionOrUnexpectedEvent: true,
      avoidGenericTopic: true,
      avoidExplicitGrammarExercise: true,
      forbiddenRequiredTopicIds: ['grammar.subjunctive'],
      forbiddenInstructions: ['Do not require use of Subjunctive Mood'],
      preferredContextFamilies: ['workplace_issue', 'travel_disruption'],
      avoidedContextFamilies: ['social_interaction'],
    },
    validationRules: {
      requiredTopicCoverage: [],
      forbiddenRequiredTopicIds: ['grammar.subjunctive'],
      maximumEstimatedLevel: 'B1',
      allowIncidentalAdvancedLanguage: true,
    },
  });

  it('includes effective level in constraints section', () => {
    const section = buildPlanConstraintsSection(plan);
    expect(section).toContain('B1');
  });

  it('includes difficulty in constraints section', () => {
    const section = buildPlanConstraintsSection(plan);
    expect(section).toContain('medium');
  });

  it('includes communicative functions', () => {
    const section = buildPlanConstraintsSection(plan);
    expect(section).toContain('Narrar uma experiência com consequências');
  });

  it('buildRepairSection includes rejection detail', () => {
    const repair = buildRepairSection(plan, 'Mission level B2 exceeds planned maximum B1');
    expect(repair).toContain('Mission level B2 exceeds planned maximum B1');
    expect(repair).toContain('B1');
  });
});
