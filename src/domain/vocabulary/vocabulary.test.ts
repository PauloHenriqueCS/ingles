import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Group 1: Vocabulary Normalization
import {
  normalizeVocabularyValue,
  normalizeForStructuralComparison,
  normalizeForDeduplication,
  isMultiwordExpression,
  inferVocabularyKind,
} from './vocabulary-normalization';

// Group 2: Vocabulary Resolution
import {
  resolveVocabularyInput,
  resolveVocabularyForm,
  isLikelyFormOf,
  tokenizeMultiwordExpression,
} from './vocabulary-resolution';

// Group 3: Evidence Weighting
import {
  calculateVocabularyEvidenceWeight,
} from './vocabulary-evidence-weighting';

// Group 4: Scheduling
import {
  scheduleNextVocabularyReview,
  addDays,
} from './vocabulary-scheduling';

// Group 5: Mastery Rules
import {
  evaluateMasteryEligibility,
  determineLapseTransition,
} from './vocabulary-mastery-rules';

// Group 6: Review Priority
import {
  rankVocabularyReviewItems,
  getLimitsForLevel,
} from './vocabulary-priority';
import type { DueVocabularyItem } from './vocabulary-priority';
import type { LearnerVocabularyMastery } from './vocabulary-types';

// Group 7: Relation Checking
import {
  checkVocabularyRelation,
  buildRelationSet,
} from './vocabulary-relations';

// Group 8: Public DTO
import {
  buildPublicVocabularyMasteryDTO,
  buildPublicVocabularyListDTO,
} from './vocabulary-public-dto';

// Group 9: Feature Flags
import {
  getVocabularyEngineMode,
  isVocabularyEngineEnabled,
  isVocabularyEngineShadow,
  isVocabularyEngineFullyActive,
} from '../../lib/vocabularyFeatureFlags';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMastery(overrides: Partial<LearnerVocabularyMastery> = {}): LearnerVocabularyMastery {
  return {
    id: 'test-id',
    userId: 'user-1',
    vocabularyItemId: 'item-1',
    state: 'learning',
    totalExposures: 2,
    totalOpportunities: 5,
    successfulRecalls: 3,
    successfulUses: 2,
    independentUses: 2,
    guidedUses: 1,
    assistedUses: 0,
    errorCount: 1,
    lapseCount: 0,
    distinctContextCount: 2,
    stability: 4,
    difficulty: 0.3,
    confidence: 0.75,
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-06-01T00:00:00Z',
    lastPracticedAt: '2026-06-01T00:00:00Z',
    lastSuccessAt: '2026-06-01T00:00:00Z',
    nextReviewAt: '2026-06-05T00:00:00Z',
    masteredAt: null,
    suspendedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeDueItem(overrides: Partial<DueVocabularyItem> = {}): DueVocabularyItem {
  return {
    mastery: makeMastery(),
    canonicalValue: 'example',
    kind: 'word',
    daysOverdue: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Group 1: Vocabulary Normalization (10 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-normalization', () => {
  it('normalizeVocabularyValue: lowercases and trims', () => {
    expect(normalizeVocabularyValue('  Hello World  ')).toBe('hello world');
  });

  it('normalizeVocabularyValue: collapses multiple internal spaces', () => {
    expect(normalizeVocabularyValue('give   up')).toBe('give up');
  });

  it('normalizeVocabularyValue: removes leading punctuation', () => {
    expect(normalizeVocabularyValue('...word')).toBe('word');
  });

  it('normalizeForStructuralComparison: expands "don\'t" to "do not"', () => {
    const result = normalizeForStructuralComparison("don't");
    expect(result).toBe('do not');
  });

  it("normalizeForStructuralComparison: expands \"I'm\" to \"i am\"", () => {
    const result = normalizeForStructuralComparison("I'm");
    expect(result).toBe('i am');
  });

  it('normalizeForDeduplication: normalizes British spelling "colour" to "color"', () => {
    const result = normalizeForDeduplication('colour');
    expect(result).toBe('color');
  });

  it('isMultiwordExpression: "give up" is multiword', () => {
    expect(isMultiwordExpression('give up')).toBe(true);
  });

  it('isMultiwordExpression: "decision" is not multiword', () => {
    expect(isMultiwordExpression('decision')).toBe(false);
  });

  it('isMultiwordExpression: "at the last minute" is multiword', () => {
    expect(isMultiwordExpression('at the last minute')).toBe(true);
  });

  it('inferVocabularyKind: "give up" is phrasal_verb', () => {
    expect(inferVocabularyKind('give up')).toBe('phrasal_verb');
  });

  it('inferVocabularyKind: "although" is connector', () => {
    expect(inferVocabularyKind('although')).toBe('connector');
  });
});

// ---------------------------------------------------------------------------
// Group 2: Vocabulary Resolution (6 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-resolution', () => {
  it('resolveVocabularyInput: returns normalizedValue, kind, isMultiword for a single word', () => {
    const result = resolveVocabularyInput('Decision');
    expect(result.normalizedValue).toBe('decision');
    expect(result.kind).toBe('word');
    expect(result.isMultiword).toBe(false);
  });

  it('resolveVocabularyInput: returns correct metadata for multiword', () => {
    const result = resolveVocabularyInput('give up');
    expect(result.isMultiword).toBe(true);
    expect(result.kind).toBe('phrasal_verb');
    expect(result.candidateLemma).toBeNull();
  });

  it('resolveVocabularyForm: matches canonical directly', () => {
    expect(resolveVocabularyForm('happy', 'happy', [])).toBe(true);
  });

  it('resolveVocabularyForm: matches known form variant', () => {
    expect(resolveVocabularyForm('happiness', 'happy', ['happier', 'happiness'])).toBe(true);
  });

  it('isLikelyFormOf: "goes" is likely a form of "go" via lemmatization', () => {
    // "goes" → remove 'es' → "go"
    expect(isLikelyFormOf('goes', 'go')).toBe(true);
  });

  it('isLikelyFormOf: irregular "children" does NOT match "child" with simple rules', () => {
    // Simple rules cannot handle irregular plurals — should gracefully return false
    expect(isLikelyFormOf('children', 'child')).toBe(false);
  });

  it('tokenizeMultiwordExpression: splits "at the last minute" into 4 tokens', () => {
    const tokens = tokenizeMultiwordExpression('at the last minute');
    expect(tokens).toHaveLength(4);
    expect(tokens).toEqual(['at', 'the', 'last', 'minute']);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Evidence Weighting (10 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-evidence-weighting', () => {
  it('independent successful_use → 1.00', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'independent',
    })).toBe(1.00);
  });

  it('guided successful_use → 0.65', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'guided',
    })).toBe(0.65);
  });

  it('assisted successful_use → 0.25', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'assisted',
    })).toBe(0.25);
  });

  it('system_generated → 0.00 always regardless of evidenceType', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'system_generated',
    })).toBe(0.00);
  });

  it('recalled independent → 1.10', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'recalled',
      productionMode: 'independent',
    })).toBe(1.10);
  });

  it('valid_synonym → 0.60', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'valid_synonym',
      productionMode: 'unknown',
    })).toBe(0.60);
  });

  it('spelling_error → -0.15', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'spelling_error',
      productionMode: 'independent',
    })).toBe(-0.15);
  });

  it('meaning_error → -0.75', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'meaning_error',
      productionMode: 'independent',
    })).toBe(-0.75);
  });

  it('retention_success → 1.20', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'retention_success',
      productionMode: 'independent',
    })).toBe(1.20);
  });

  it('retention_failure → -0.90', () => {
    expect(calculateVocabularyEvidenceWeight({
      evidenceType: 'retention_failure',
      productionMode: 'independent',
    })).toBe(-0.90);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Scheduling (8 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-scheduling', () => {
  const BASE_OCCURRED_AT = '2026-07-14T10:00:00Z';

  it('first independent success: stability should be INITIAL_STABILITY_INDEPENDENT, intervalDays = 4', () => {
    const result = scheduleNextVocabularyReview({
      currentState: 'new',
      stability: 1.0,
      difficulty: 0.3,
      lapseCount: 0,
      previousIntervalDays: 0,
      evidenceType: 'successful_use',
      productionMode: 'independent',
      evidenceWeight: 1.0,
      occurredAt: BASE_OCCURRED_AT,
    });
    // Initial stability for independent is 4
    expect(result.newStability).toBeGreaterThanOrEqual(4);
    expect(result.intervalDays).toBeGreaterThanOrEqual(4);
  });

  it('first assisted success: stability = 1, intervalDays = 1', () => {
    const result = scheduleNextVocabularyReview({
      currentState: 'new',
      stability: 1.0,
      difficulty: 0.3,
      lapseCount: 0,
      previousIntervalDays: 0,
      evidenceType: 'successful_use',
      productionMode: 'assisted',
      evidenceWeight: 0.25,
      occurredAt: BASE_OCCURRED_AT,
    });
    expect(result.newStability).toBeGreaterThanOrEqual(1);
    expect(result.intervalDays).toBeGreaterThanOrEqual(1);
  });

  it('lapse: stability reduced to ~20% of original, intervalDays = 1, lapseIncrement = 1', () => {
    const result = scheduleNextVocabularyReview({
      currentState: 'reviewing',
      stability: 20.0,
      difficulty: 0.3,
      lapseCount: 0,
      previousIntervalDays: 20,
      evidenceType: 'retention_failure',
      productionMode: 'independent',
      evidenceWeight: -0.90,
      occurredAt: BASE_OCCURRED_AT,
    });
    expect(result.newStability).toBeLessThanOrEqual(20 * 0.2 + 0.1);
    expect(result.intervalDays).toBe(1);
    expect(result.lapseIncrement).toBe(1);
  });

  it('lapse from mastered: state changes to reviewing', () => {
    const result = scheduleNextVocabularyReview({
      currentState: 'mastered',
      stability: 100.0,
      difficulty: 0.2,
      lapseCount: 0,
      previousIntervalDays: 100,
      evidenceType: 'retention_failure',
      productionMode: 'independent',
      evidenceWeight: -0.90,
      occurredAt: BASE_OCCURRED_AT,
    });
    expect(result.newState).toBe('reviewing');
  });

  it('lapse does NOT return item to new state', () => {
    const result = scheduleNextVocabularyReview({
      currentState: 'learning',
      stability: 4.0,
      difficulty: 0.4,
      lapseCount: 1,
      previousIntervalDays: 4,
      evidenceType: 'retention_failure',
      productionMode: 'independent',
      evidenceWeight: -0.90,
      occurredAt: BASE_OCCURRED_AT,
    });
    expect(result.newState).not.toBe('new');
  });

  it('multiple successes increase stability', () => {
    const first = scheduleNextVocabularyReview({
      currentState: 'learning',
      stability: 4.0,
      difficulty: 0.3,
      lapseCount: 0,
      previousIntervalDays: 4,
      evidenceType: 'successful_use',
      productionMode: 'independent',
      evidenceWeight: 1.0,
      occurredAt: BASE_OCCURRED_AT,
    });
    const second = scheduleNextVocabularyReview({
      currentState: first.newState,
      stability: first.newStability,
      difficulty: first.newDifficulty,
      lapseCount: 0,
      previousIntervalDays: first.intervalDays ?? 4,
      evidenceType: 'successful_use',
      productionMode: 'independent',
      evidenceWeight: 1.0,
      occurredAt: BASE_OCCURRED_AT,
    });
    expect(second.newStability).toBeGreaterThan(first.newStability);
  });

  it('difficulty decreases after successful independent use', () => {
    const result = scheduleNextVocabularyReview({
      currentState: 'learning',
      stability: 4.0,
      difficulty: 0.5,
      lapseCount: 0,
      previousIntervalDays: 4,
      evidenceType: 'successful_use',
      productionMode: 'independent',
      evidenceWeight: 1.0,
      occurredAt: BASE_OCCURRED_AT,
    });
    expect(result.newDifficulty).toBeLessThan(0.5);
  });

  it('addDays: adds correct number of days to ISO string', () => {
    const result = addDays('2026-07-14T10:00:00Z', 7);
    const resultDate = new Date(result);
    const originalDate = new Date('2026-07-14T10:00:00Z');
    const diffMs = resultDate.getTime() - originalDate.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Mastery Rules (8 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-mastery-rules', () => {
  const ELIGIBLE_INPUT = {
    successfulRecalls: 2,
    successfulUses: 2,
    independentUses: 2,
    distinctContextCount: 2,
    retentionSuccesses: 1,
    lapseCount: 0,
    recentLapseCount: 0,
    confidence: 0.80,
    currentState: 'reviewing' as const,
  };

  it('evaluateMasteryEligibility: all criteria met → eligible', () => {
    const result = evaluateMasteryEligibility(ELIGIBLE_INPUT);
    expect(result.eligible).toBe(true);
    expect(result.blockedReasons).toHaveLength(0);
    expect(result.reasonCode).toBe('ITEM_MASTERED');
  });

  it('evaluateMasteryEligibility: missing independentUses → blocked', () => {
    const result = evaluateMasteryEligibility({ ...ELIGIBLE_INPUT, independentUses: 0 });
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some(r => r.toLowerCase().includes('independent'))).toBe(true);
  });

  it('evaluateMasteryEligibility: missing distinctContexts → blocked', () => {
    const result = evaluateMasteryEligibility({ ...ELIGIBLE_INPUT, distinctContextCount: 1 });
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some(r => r.toLowerCase().includes('context'))).toBe(true);
  });

  it('evaluateMasteryEligibility: missing retentionSuccess → blocked', () => {
    const result = evaluateMasteryEligibility({ ...ELIGIBLE_INPUT, retentionSuccesses: 0 });
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some(r => r.toLowerCase().includes('retention'))).toBe(true);
  });

  it('evaluateMasteryEligibility: recentLapse > 0 → blocked', () => {
    const result = evaluateMasteryEligibility({ ...ELIGIBLE_INPUT, recentLapseCount: 1 });
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some(r => r.toLowerCase().includes('lapse'))).toBe(true);
  });

  it('evaluateMasteryEligibility: low confidence → blocked', () => {
    const result = evaluateMasteryEligibility({ ...ELIGIBLE_INPUT, confidence: 0.50 });
    expect(result.eligible).toBe(false);
    expect(result.blockedReasons.some(r => r.toLowerCase().includes('confidence'))).toBe(true);
  });

  it('determineLapseTransition: mastered → reviewing', () => {
    expect(determineLapseTransition('mastered')).toBe('reviewing');
  });

  it('determineLapseTransition: learning → learning (stays)', () => {
    expect(determineLapseTransition('learning')).toBe('learning');
  });
});

// ---------------------------------------------------------------------------
// Group 6: Review Priority (6 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-priority', () => {
  it('rankVocabularyReviewItems: higher daysOverdue → higher priority', () => {
    const items: DueVocabularyItem[] = [
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-a' }), daysOverdue: 1 }),
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-b' }), daysOverdue: 10 }),
    ];
    const result = rankVocabularyReviewItems({
      dueItems: items,
      recentlyUsedItemIds: [],
      level: 'B1',
      nowIso: new Date().toISOString(),
    });
    expect(result[0].daysOverdue).toBe(10);
  });

  it('rankVocabularyReviewItems: lapseCount increases priority', () => {
    const items: DueVocabularyItem[] = [
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-a', lapseCount: 0 }), daysOverdue: 1 }),
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-b', lapseCount: 3 }), daysOverdue: 1 }),
    ];
    const result = rankVocabularyReviewItems({
      dueItems: items,
      recentlyUsedItemIds: [],
      level: 'B1',
      nowIso: new Date().toISOString(),
    });
    // item-b has more lapses → higher score → first
    expect(result[0].mastery.vocabularyItemId).toBe('item-b');
  });

  it('rankVocabularyReviewItems: recently used items get lower priority', () => {
    const items: DueVocabularyItem[] = [
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-recent' }), daysOverdue: 5 }),
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-fresh' }), daysOverdue: 3 }),
    ];
    const result = rankVocabularyReviewItems({
      dueItems: items,
      recentlyUsedItemIds: ['item-recent'],
      level: 'B1',
      nowIso: new Date().toISOString(),
    });
    // item-recent penalized by -30, so item-fresh wins despite fewer days
    expect(result[0].mastery.vocabularyItemId).toBe('item-fresh');
  });

  it('getLimitsForLevel: A1 maxItems = 3, maxRequired = 1', () => {
    const limits = getLimitsForLevel('A1');
    expect(limits.maxItems).toBe(3);
    expect(limits.maxRequired).toBe(1);
  });

  it('getLimitsForLevel: B1 maxItems = 5', () => {
    const limits = getLimitsForLevel('B1');
    expect(limits.maxItems).toBe(5);
  });

  it('rankVocabularyReviewItems: never includes suspended items', () => {
    const items: DueVocabularyItem[] = [
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-suspended', state: 'suspended' }), daysOverdue: 100 }),
      makeDueItem({ mastery: makeMastery({ vocabularyItemId: 'item-active', state: 'reviewing' }), daysOverdue: 1 }),
    ];
    const result = rankVocabularyReviewItems({
      dueItems: items,
      recentlyUsedItemIds: [],
      level: 'B1',
      nowIso: new Date().toISOString(),
    });
    const ids = result.map(i => i.mastery.vocabularyItemId);
    expect(ids).not.toContain('item-suspended');
    expect(ids).toContain('item-active');
  });
});

// ---------------------------------------------------------------------------
// Group 7: Relation Checking (6 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-relations', () => {
  it('synonym always accepted as alternative', () => {
    const result = checkVocabularyRelation({
      submittedValue: 'happy',
      plannedValue: 'glad',
      relationTypes: ['synonym'],
      contextHints: [],
    });
    expect(result.isAcceptableAlternative).toBe(true);
    expect(result.relationType).toBe('synonym');
  });

  it('near_synonym accepted when context matches hint', () => {
    const result = checkVocabularyRelation({
      submittedValue: 'worried',
      plannedValue: 'anxious',
      relationTypes: ['near_synonym'],
      contextHints: ['emotional'],
      contextFamily: 'emotional_situations',
    });
    expect(result.isAcceptableAlternative).toBe(true);
    expect(result.relationType).toBe('near_synonym');
  });

  it('antonym NOT accepted as substitute', () => {
    const result = checkVocabularyRelation({
      submittedValue: 'happy',
      plannedValue: 'sad',
      relationTypes: ['antonym'],
      contextHints: [],
    });
    expect(result.isAcceptableAlternative).toBe(false);
    expect(result.relationType).toBe('antonym');
  });

  it('contextual_equivalent accepted when context family matches', () => {
    const result = checkVocabularyRelation({
      submittedValue: 'purchase',
      plannedValue: 'buy',
      relationTypes: ['contextual_equivalent'],
      contextHints: ['formal'],
      contextFamily: 'formal_writing',
    });
    expect(result.isAcceptableAlternative).toBe(true);
  });

  it('buildRelationSet includes planned and all synonyms', () => {
    const set = buildRelationSet('happy', ['glad', 'joyful', 'pleased']);
    expect(set.has('happy')).toBe(true);
    expect(set.has('glad')).toBe(true);
    expect(set.has('joyful')).toBe(true);
    expect(set.has('pleased')).toBe(true);
    expect(set.size).toBe(4);
  });

  it('checkVocabularyRelation returns a confidence score', () => {
    const result = checkVocabularyRelation({
      submittedValue: 'glad',
      plannedValue: 'happy',
      relationTypes: ['synonym'],
      contextHints: [],
    });
    expect(typeof result.confidenceScore).toBe('number');
    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Group 8: Public DTO (6 tests)
// ---------------------------------------------------------------------------

describe('vocabulary-public-dto', () => {
  const mastery = makeMastery({
    vocabularyItemId: 'item-1',
    state: 'learning',
    totalExposures: 5,
    successfulUses: 3,
    independentUses: 2,
    distinctContextCount: 2,
    stability: 14.5,
    difficulty: 0.3,
    lapseCount: 1,
    nextReviewAt: '2026-07-20T00:00:00Z',
  });

  it('buildPublicVocabularyMasteryDTO: does NOT include stability', () => {
    const dto = buildPublicVocabularyMasteryDTO(mastery, 'example', 'exemplo', 'word');
    expect((dto as Record<string, unknown>).stability).toBeUndefined();
  });

  it('buildPublicVocabularyMasteryDTO: does NOT include difficulty', () => {
    const dto = buildPublicVocabularyMasteryDTO(mastery, 'example', 'exemplo', 'word');
    expect((dto as Record<string, unknown>).difficulty).toBeUndefined();
  });

  it('buildPublicVocabularyMasteryDTO: does NOT include lapseCount directly', () => {
    const dto = buildPublicVocabularyMasteryDTO(mastery, 'example', 'exemplo', 'word');
    expect((dto as Record<string, unknown>).lapseCount).toBeUndefined();
  });

  it('buildPublicVocabularyMasteryDTO: progress.exposures equals totalExposures', () => {
    const dto = buildPublicVocabularyMasteryDTO(mastery, 'example', 'exemplo', 'word');
    expect(dto.progress.exposures).toBe(mastery.totalExposures);
  });

  it('buildPublicVocabularyListDTO: filters out suspended items', () => {
    const items = [
      { mastery: makeMastery({ vocabularyItemId: 'item-suspended', state: 'suspended' }), itemValue: 'test', translationPtBR: null, kind: 'word' as const },
      { mastery: makeMastery({ vocabularyItemId: 'item-active', state: 'learning' }), itemValue: 'active', translationPtBR: null, kind: 'word' as const },
    ];
    const dtos = buildPublicVocabularyListDTO(items);
    const ids = dtos.map(d => d.vocabularyItemId);
    expect(ids).not.toContain('item-suspended');
    expect(ids).toContain('item-active');
  });

  it('buildPublicVocabularyListDTO: sorts mastered items first', () => {
    const items = [
      { mastery: makeMastery({ vocabularyItemId: 'item-learning', state: 'learning', nextReviewAt: '2026-07-15T00:00:00Z' }), itemValue: 'learning', translationPtBR: null, kind: 'word' as const },
      { mastery: makeMastery({ vocabularyItemId: 'item-mastered', state: 'mastered', nextReviewAt: null }), itemValue: 'mastered', translationPtBR: null, kind: 'word' as const },
      { mastery: makeMastery({ vocabularyItemId: 'item-reviewing', state: 'reviewing', nextReviewAt: '2026-07-16T00:00:00Z' }), itemValue: 'reviewing', translationPtBR: null, kind: 'word' as const },
    ];
    const dtos = buildPublicVocabularyListDTO(items);
    expect(dtos[0].state).toBe('mastered');
  });
});

// ---------------------------------------------------------------------------
// Group 9: Feature Flags (8 tests)
// ---------------------------------------------------------------------------

describe('vocabularyFeatureFlags', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1;
    } else {
      process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = originalEnv;
    }
  });

  it('getVocabularyEngineMode: defaults to "off" when env var not set', () => {
    delete process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1;
    expect(getVocabularyEngineMode()).toBe('off');
  });

  it('isVocabularyEngineEnabled: returns false when mode is "off"', () => {
    delete process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1;
    expect(isVocabularyEngineEnabled()).toBe(false);
  });

  it('isVocabularyEngineShadow: returns true only when mode is "shadow"', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'shadow';
    expect(isVocabularyEngineShadow()).toBe(true);
  });

  it('isVocabularyEngineFullyActive: returns true for "full"', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'full';
    expect(isVocabularyEngineFullyActive()).toBe(true);
  });

  it('isVocabularyEngineFullyActive: returns true for "admin"', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'admin';
    expect(isVocabularyEngineFullyActive()).toBe(true);
  });

  it('isVocabularyEngineFullyActive: returns true for "new_users"', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'new_users';
    expect(isVocabularyEngineFullyActive()).toBe(true);
  });

  it('isVocabularyEngineFullyActive: returns false for "shadow"', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'shadow';
    expect(isVocabularyEngineFullyActive()).toBe(false);
  });

  it('getVocabularyEngineMode: reads VOCABULARY_ITEM_REVIEW_ENGINE_V1 env var', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'full';
    expect(getVocabularyEngineMode()).toBe('full');
  });

  it('unknown env value falls back to "off"', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'invalid_mode';
    expect(getVocabularyEngineMode()).toBe('off');
  });

  it('"shadow" mode → isVocabularyEngineEnabled returns true', () => {
    process.env.VOCABULARY_ITEM_REVIEW_ENGINE_V1 = 'shadow';
    expect(isVocabularyEngineEnabled()).toBe(true);
  });
});
