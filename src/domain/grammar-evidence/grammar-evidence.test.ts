import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { calculateEvidenceWeight, isPositiveEvidence, isNegativeEvidence } from './evidence-weighting';
import { resolveProductionMode, productionModeToSupportLevel } from './production-mode';
import { evaluateGrammarOpportunity } from './opportunity-evaluation';
import {
  extractContextFamily,
  buildContextKey,
  areDistinctContexts,
  countDistinctContextFamilies,
} from './context-diversity';
import { calculateGrammarMasteryConfidence } from './mastery-confidence';
import {
  evaluateForwardTransition,
  evaluateRegressionTransition,
  CONSOLIDATION_CRITERIA_V1,
  MASTERY_CRITERIA_V1,
} from './mastery-rules';
import type { MasteryAggregate } from './mastery-rules';
import { buildEvidenceIdempotencyKey } from '../../lib/grammarEvidenceIdempotency';
import { buildPublicMasteryDTO } from './public-mastery-dto';
import {
  getGrammarEvidenceEngineMode,
  isGrammarEvidenceEngineEnabled,
  isGrammarEvidenceEngineShadow,
  isGrammarEvidenceEngineFullyActive,
} from '../../lib/grammarEvidenceFeatureFlags';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeAggregate(overrides: Partial<MasteryAggregate> = {}): MasteryAggregate {
  return {
    totalOpportunities: 0,
    successfulUses: 0,
    partialUses: 0,
    errorCount: 0,
    independentUses: 0,
    guidedUses: 0,
    assistedUses: 0,
    retentionSuccesses: 0,
    retentionFailures: 0,
    distinctContextCount: 0,
    weightedSuccessScore: 0,
    weightedErrorScore: 0,
    confidence: 0,
    currentState: 'locked',
    ...overrides,
  };
}

function makeConsolidationReadyAggregate(): MasteryAggregate {
  return makeAggregate({
    currentState: 'practicing',
    totalOpportunities: CONSOLIDATION_CRITERIA_V1.minOpportunities,
    successfulUses: CONSOLIDATION_CRITERIA_V1.minSuccessfulUses,
    independentUses: CONSOLIDATION_CRITERIA_V1.minIndependentUses,
    distinctContextCount: CONSOLIDATION_CRITERIA_V1.minDistinctContexts,
    confidence: CONSOLIDATION_CRITERIA_V1.minConfidence,
    weightedSuccessScore: 3.0,
    weightedErrorScore: 0.5,
  });
}

function makeMasteryReadyAggregate(): MasteryAggregate {
  return makeAggregate({
    currentState: 'consolidating',
    totalOpportunities: MASTERY_CRITERIA_V1.minOpportunities,
    successfulUses: MASTERY_CRITERIA_V1.minSuccessfulUses,
    independentUses: MASTERY_CRITERIA_V1.minIndependentUses,
    distinctContextCount: MASTERY_CRITERIA_V1.minDistinctContexts,
    retentionSuccesses: MASTERY_CRITERIA_V1.minRetentionSuccesses,
    confidence: MASTERY_CRITERIA_V1.minConfidence,
    weightedSuccessScore: 8.0,
    weightedErrorScore: 1.0, // precision = 8/9 ≈ 0.889 > 0.80
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: Evidence weighting (10 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Evidence weighting', () => {
  it('independent successful use → weight = 1.00', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'independent',
      topicRole: 'primary',
    });
    expect(weight).toBe(1.00);
  });

  it('guided successful use → weight = 0.65', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'guided',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.65);
  });

  it('assisted successful use → weight = 0.30', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'assisted',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.30);
  });

  it('system_generated → weight = 0.00 always', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'successful_use',
      productionMode: 'system_generated',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.00);
  });

  it('error in primary topic → weight = -0.70', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'error',
      productionMode: 'independent',
      topicRole: 'primary',
    });
    expect(weight).toBe(-0.70);
    expect(isNegativeEvidence(weight)).toBe(true);
  });

  it('error in locked topic → weight = -0.05 (minimal)', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'error',
      productionMode: 'independent',
      topicRole: 'locked',
    });
    expect(weight).toBe(-0.05);
  });

  it('partial independent → weight = 0.45', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'partial_success',
      productionMode: 'independent',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.45);
    expect(isPositiveEvidence(weight)).toBe(true);
  });

  it('retention_success → weight = 0.90', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'retention_success',
      productionMode: 'independent',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.90);
  });

  it('attempt_above_level → weight = 0.05 (small positive)', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'attempt_above_level',
      productionMode: 'independent',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.05);
    expect(isPositiveEvidence(weight)).toBe(true);
  });

  it('no_opportunity → weight = 0.00', () => {
    const weight = calculateEvidenceWeight({
      evidenceType: 'no_opportunity',
      productionMode: 'independent',
      topicRole: 'primary',
    });
    expect(weight).toBe(0.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: Production mode resolution (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Production mode resolution', () => {
  it('original submission, no help, no planned topic → independent', () => {
    const mode = resolveProductionMode({
      submissionType: 'original',
      sourceType: 'original_review',
      plannedTopic: false,
      helpUsed: false,
    });
    expect(mode).toBe('independent');
  });

  it('rewrite with correctedTextVisible=true → assisted', () => {
    const mode = resolveProductionMode({
      submissionType: 'rewrite_v2',
      sourceType: 'rewrite_evaluation',
      correctedTextVisible: true,
      helpUsed: false,
    });
    expect(mode).toBe('assisted');
  });

  it('rewrite with copied assessment → assisted', () => {
    const mode = resolveProductionMode({
      submissionType: 'rewrite_v2',
      sourceType: 'rewrite_evaluation',
      copySignalAssessment: 'copied',
    });
    expect(mode).toBe('assisted');
  });

  it('likely_copied assessment → assisted', () => {
    const mode = resolveProductionMode({
      submissionType: 'rewrite_v2',
      sourceType: 'rewrite_evaluation',
      copySignalAssessment: 'likely_copied',
    });
    expect(mode).toBe('assisted');
  });

  it('mission directs structure, no text help → guided', () => {
    const mode = resolveProductionMode({
      submissionType: 'original',
      sourceType: 'original_review',
      plannedTopic: true,
      missionHasDirectInstruction: true,
      helpUsed: false,
      correctedTextVisible: false,
    });
    expect(mode).toBe('guided');
  });

  it('manual_admin source → system_generated', () => {
    const mode = resolveProductionMode({
      submissionType: 'original',
      sourceType: 'manual_admin',
    });
    expect(mode).toBe('system_generated');
  });

  it('support sentences available, no corrections visible → guided', () => {
    const mode = resolveProductionMode({
      submissionType: 'rewrite_v2',
      sourceType: 'rewrite_evaluation',
      supportSentencesAvailable: true,
      correctedTextVisible: false,
    });
    expect(mode).toBe('guided');
  });

  it('independent assessment, no visible corrections, no help → independent', () => {
    const mode = resolveProductionMode({
      submissionType: 'rewrite_v2',
      sourceType: 'rewrite_evaluation',
      copySignalAssessment: 'likely_independent',
      correctedTextVisible: false,
      helpUsed: false,
    });
    expect(mode).toBe('independent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: Opportunity evaluation (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Opportunity evaluation', () => {
  it('locked topic, no mission requirement → no_opportunity (none)', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.present_perfect',
      topicRole: 'locked',
      submissionTextLength: 200,
      plannedTopic: false,
      topicExpectedInContext: false,
      estimatedOccurrencesInText: 0,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(false);
    expect(result.strength).toBe('none');
    expect(result.opportunityWeight).toBe(0);
  });

  it('text shorter than 30 chars → none', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.present_simple',
      topicRole: 'primary',
      submissionTextLength: 20,
      plannedTopic: true,
      topicExpectedInContext: true,
      estimatedOccurrencesInText: 1,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(false);
    expect(result.strength).toBe('none');
  });

  it('level below minimum and not required by mission → none', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.subjunctive',
      topicRole: 'primary',
      submissionTextLength: 150,
      plannedTopic: false,
      topicExpectedInContext: false,
      estimatedOccurrencesInText: 0,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: false,
    });
    expect(result.hasOpportunity).toBe(false);
    expect(result.strength).toBe('none');
  });

  it('estimated 0 occurrences, not planned → none', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.past_perfect',
      topicRole: 'unplanned',
      submissionTextLength: 200,
      plannedTopic: false,
      topicExpectedInContext: false,
      estimatedOccurrencesInText: 0,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(false);
    expect(result.strength).toBe('none');
  });

  it('planned topic, 2+ occurrences → strong', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.present_continuous',
      topicRole: 'primary',
      submissionTextLength: 300,
      plannedTopic: true,
      topicExpectedInContext: true,
      estimatedOccurrencesInText: 3,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(true);
    expect(result.strength).toBe('strong');
    expect(result.opportunityWeight).toBe(1.0);
  });

  it('mission required structure → strong', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.past_simple',
      topicRole: 'primary',
      submissionTextLength: 200,
      plannedTopic: true,
      topicExpectedInContext: true,
      estimatedOccurrencesInText: 1,
      missionRequiredStructure: true,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(true);
    expect(result.strength).toBe('strong');
    expect(result.opportunityWeight).toBe(1.0);
  });

  it('exposure only role → weak', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.passive_voice',
      topicRole: 'exposure_only',
      submissionTextLength: 200,
      plannedTopic: false,
      topicExpectedInContext: true,
      estimatedOccurrencesInText: 1,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(true);
    expect(result.strength).toBe('weak');
    expect(result.opportunityWeight).toBe(0.3);
  });

  it('planned topic, 1 occurrence → moderate', () => {
    const result = evaluateGrammarOpportunity({
      topicId: 'grammar.present_simple',
      topicRole: 'primary',
      submissionTextLength: 200,
      plannedTopic: true,
      topicExpectedInContext: true,
      estimatedOccurrencesInText: 1,
      missionRequiredStructure: false,
      levelMatchesTopicMinimum: true,
    });
    expect(result.hasOpportunity).toBe(true);
    expect(result.strength).toBe('moderate');
    expect(result.opportunityWeight).toBe(0.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: Context diversity (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Context diversity', () => {
  it("extractContextFamily('work.delay') → 'work'", () => {
    expect(extractContextFamily('work.delay')).toBe('work');
  });

  it("extractContextFamily('travel.problem') → 'travel'", () => {
    expect(extractContextFamily('travel.problem')).toBe('travel');
  });

  it("extractContextFamily('unknown_string') → 'unknown'", () => {
    expect(extractContextFamily('unknown_string')).toBe('unknown');
  });

  it('areDistinctContexts: different families → true', () => {
    expect(areDistinctContexts('work:topic1:sub', 'travel:topic1:sub')).toBe(true);
  });

  it('areDistinctContexts: same family → false', () => {
    expect(areDistinctContexts('work:topic1:abc', 'work:topic2:xyz')).toBe(false);
  });

  it('countDistinctContextFamilies: 3 keys with 2 distinct families → 2', () => {
    const keys = ['work:topicA:s1', 'travel:topicA:s2', 'work:topicA:s3'];
    expect(countDistinctContextFamilies(keys)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: Mastery confidence calculation (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Mastery confidence calculation', () => {
  it('all successes, high independence → confidence near 1.0', () => {
    const conf = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 10.0,
      weightedErrorScore: 0.0,
      independentUses: 5,
      distinctContexts: 4,
      retentionSuccesses: 2,
      retentionFailures: 0,
      evidenceCount: 12,
      lastEvidenceAgeDays: 0,
    });
    expect(conf).toBeGreaterThan(0.90);
    expect(conf).toBeLessThanOrEqual(1.0);
  });

  it('all failures → confidence near 0.0', () => {
    const conf = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 0.0,
      weightedErrorScore: 5.0,
      independentUses: 0,
      distinctContexts: 1,
      retentionSuccesses: 0,
      retentionFailures: 3,
      evidenceCount: 5,
      lastEvidenceAgeDays: 0,
    });
    expect(conf).toBeLessThan(0.15);
    expect(conf).toBeGreaterThanOrEqual(0.0);
  });

  it('recent evidence → higher confidence than old evidence', () => {
    const base = {
      weightedSuccessScore: 5.0,
      weightedErrorScore: 1.0,
      independentUses: 2,
      distinctContexts: 2,
      retentionSuccesses: 1,
      retentionFailures: 0,
      evidenceCount: 6,
    };
    const recentConf = calculateGrammarMasteryConfidence({ ...base, lastEvidenceAgeDays: 0 });
    const oldConf = calculateGrammarMasteryConfidence({ ...base, lastEvidenceAgeDays: 180 });
    expect(recentConf).toBeGreaterThan(oldConf);
  });

  it('volume bonus caps at 0.15 (at 10+ evidence)', () => {
    // With 20 evidence items: volumeBonus = min(0.15, 20 * 0.015) = min(0.15, 0.30) = 0.15
    const highVolumeConf = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 10.0,
      weightedErrorScore: 0.0,
      independentUses: 0,
      distinctContexts: 0,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 20,
      lastEvidenceAgeDays: 0,
    });
    // With 10 items: volumeBonus = 0.15 (same cap)
    const tenItemConf = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 10.0,
      weightedErrorScore: 0.0,
      independentUses: 0,
      distinctContexts: 0,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 10,
      lastEvidenceAgeDays: 0,
    });
    expect(highVolumeConf).toBeCloseTo(tenItemConf, 5);
  });

  it('independence bonus caps at 0.10 (at 3+ independent uses)', () => {
    const threeIndep = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 5.0,
      weightedErrorScore: 0.0,
      independentUses: 3,
      distinctContexts: 0,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 5,
      lastEvidenceAgeDays: 0,
    });
    const tenIndep = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 5.0,
      weightedErrorScore: 0.0,
      independentUses: 10,
      distinctContexts: 0,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 5,
      lastEvidenceAgeDays: 0,
    });
    expect(threeIndep).toBeCloseTo(tenIndep, 5);
  });

  it('diversity bonus caps at 0.10 (at 3+ distinct contexts)', () => {
    const threeContexts = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 5.0,
      weightedErrorScore: 0.0,
      independentUses: 0,
      distinctContexts: 3,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 5,
      lastEvidenceAgeDays: 0,
    });
    const tenContexts = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 5.0,
      weightedErrorScore: 0.0,
      independentUses: 0,
      distinctContexts: 10,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 5,
      lastEvidenceAgeDays: 0,
    });
    expect(threeContexts).toBeCloseTo(tenContexts, 5);
  });

  it('retention failure dampens confidence', () => {
    const withRetentionFailures = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 5.0,
      weightedErrorScore: 0.5,
      independentUses: 2,
      distinctContexts: 2,
      retentionSuccesses: 1,
      retentionFailures: 3,
      evidenceCount: 8,
      lastEvidenceAgeDays: 0,
    });
    const withoutRetentionFailures = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 5.0,
      weightedErrorScore: 0.5,
      independentUses: 2,
      distinctContexts: 2,
      retentionSuccesses: 0,
      retentionFailures: 0,
      evidenceCount: 8,
      lastEvidenceAgeDays: 0,
    });
    expect(withRetentionFailures).toBeLessThan(withoutRetentionFailures);
  });

  it('confidence always clamped between 0 and 1', () => {
    const extreme1 = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 999,
      weightedErrorScore: 0,
      independentUses: 999,
      distinctContexts: 999,
      retentionSuccesses: 999,
      retentionFailures: 0,
      evidenceCount: 999,
      lastEvidenceAgeDays: 0,
    });
    const extreme2 = calculateGrammarMasteryConfidence({
      weightedSuccessScore: 0,
      weightedErrorScore: 999,
      independentUses: 0,
      distinctContexts: 0,
      retentionSuccesses: 0,
      retentionFailures: 999,
      evidenceCount: 0,
      lastEvidenceAgeDays: 999,
    });
    expect(extreme1).toBeLessThanOrEqual(1.0);
    expect(extreme2).toBeGreaterThanOrEqual(0.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 6: Mastery rules — forward transitions (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Mastery rules — forward transitions', () => {
  it('introduced: 1 opportunity → can transition to practicing', () => {
    const agg = makeAggregate({
      currentState: 'introduced',
      totalOpportunities: 1,
    });
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('practicing');
  });

  it('practicing: < 4 opportunities → cannot transition to consolidating', () => {
    const agg = makeAggregate({
      currentState: 'practicing',
      totalOpportunities: 2,
      successfulUses: 2,
      independentUses: 1,
      distinctContextCount: 2,
      confidence: 0.60,
    });
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(false);
    expect(result.targetState).toBeNull();
    expect(result.blockedReasons.some(r => r.includes('opportunities'))).toBe(true);
  });

  it('practicing: meets all consolidation criteria → can transition to consolidating', () => {
    const agg = makeConsolidationReadyAggregate();
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('consolidating');
    expect(result.reasonCode).toBe('SUFFICIENT_PRACTICE_EVIDENCE');
  });

  it('consolidating: meets all mastery criteria → can transition to mastered', () => {
    const agg = makeMasteryReadyAggregate();
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('mastered');
    expect(result.reasonCode).toBe('MASTERY_CRITERIA_MET');
  });

  it('consolidating: missing independent uses → blocked', () => {
    const agg = makeMasteryReadyAggregate();
    agg.independentUses = 0; // below minimum
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(false);
    expect(result.blockedReasons.some(r => r.includes('independent'))).toBe(true);
  });

  it('consolidating: missing distinct contexts → blocked', () => {
    const agg = makeMasteryReadyAggregate();
    agg.distinctContextCount = 1; // below minimum of 3
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(false);
    expect(result.blockedReasons.some(r => r.includes('context'))).toBe(true);
  });

  it('consolidating: missing retention success → blocked for mastered', () => {
    const agg = makeMasteryReadyAggregate();
    agg.retentionSuccesses = 0; // below minimum of 1
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(false);
    expect(result.blockedReasons.some(r => r.includes('retention'))).toBe(true);
  });

  it('mastered: maintenance call → can transition', () => {
    const agg = makeAggregate({ currentState: 'mastered', confidence: 0.85 });
    const result = evaluateForwardTransition(agg);
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('maintenance');
    expect(result.reasonCode).toBe('MAINTENANCE_DUE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 7: Mastery rules — regression (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Mastery rules — regression', () => {
  it('mastered: single failure → NO regression', () => {
    const agg = makeAggregate({
      currentState: 'mastered',
      confidence: 0.85,
      retentionFailures: 0,
    });
    const result = evaluateRegressionTransition(agg, {
      failureCount: 1,
      opportunityCount: 2,
      distinctContextsWithFailure: 1,
    });
    expect(result.canTransition).toBe(false);
  });

  it('mastered: 3+ failures, 2 contexts, retention failure, confidence < 0.60 → regress to consolidating', () => {
    const agg = makeAggregate({
      currentState: 'mastered',
      confidence: 0.45,
      retentionFailures: 2,
      retentionSuccesses: 1,
    });
    const result = evaluateRegressionTransition(agg, {
      failureCount: 3,
      opportunityCount: 4,
      distinctContextsWithFailure: 2,
    });
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('consolidating');
    expect(result.reasonCode).toBe('RETENTION_FAILURE');
  });

  it('consolidating: single failure → NO regression', () => {
    const agg = makeAggregate({
      currentState: 'consolidating',
      confidence: 0.60,
    });
    const result = evaluateRegressionTransition(agg, {
      failureCount: 1,
      opportunityCount: 2,
      distinctContextsWithFailure: 1,
    });
    expect(result.canTransition).toBe(false);
  });

  it('consolidating: 4+ failures, 2 contexts, confidence < 0.40 → regress to practicing', () => {
    const agg = makeAggregate({
      currentState: 'consolidating',
      confidence: 0.30,
    });
    const result = evaluateRegressionTransition(agg, {
      failureCount: 4,
      opportunityCount: 5,
      distinctContextsWithFailure: 2,
    });
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('practicing');
    expect(result.reasonCode).toBe('REPEATED_RECENT_FAILURES');
  });

  it('never regress to locked from any state', () => {
    const states = ['introduced', 'practicing', 'consolidating', 'mastered', 'maintenance'] as const;
    for (const state of states) {
      const agg = makeAggregate({ currentState: state, confidence: 0.01 });
      const result = evaluateRegressionTransition(agg, {
        failureCount: 100,
        opportunityCount: 100,
        distinctContextsWithFailure: 100,
      });
      expect(result.targetState).not.toBe('locked');
    }
  });

  it('maintenance: 2 retention failures, no successes, confidence < 0.50 → consolidating', () => {
    const agg = makeAggregate({
      currentState: 'maintenance',
      confidence: 0.40,
      retentionFailures: 2,
      retentionSuccesses: 0,
    });
    const result = evaluateRegressionTransition(agg, {
      failureCount: 2,
      opportunityCount: 3,
      distinctContextsWithFailure: 1,
    });
    expect(result.canTransition).toBe(true);
    expect(result.targetState).toBe('consolidating');
    expect(result.reasonCode).toBe('RETENTION_FAILURE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 8: Idempotency key (2 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Idempotency key', () => {
  it('same inputs → same key', () => {
    const params = {
      sourceType: 'rewrite_evaluation' as const,
      sourceId: 'sub-abc-123',
      grammarTopicId: 'grammar.present_simple',
      evidenceType: 'successful_use' as const,
      contextKey: 'work:topic:abc',
    };
    const key1 = buildEvidenceIdempotencyKey(params);
    const key2 = buildEvidenceIdempotencyKey(params);
    expect(key1).toBe(key2);
  });

  it('different sourceId → different key', () => {
    const base = {
      sourceType: 'rewrite_evaluation' as const,
      grammarTopicId: 'grammar.present_simple',
      evidenceType: 'successful_use' as const,
      contextKey: 'work:topic:abc',
    };
    const key1 = buildEvidenceIdempotencyKey({ ...base, sourceId: 'sub-001' });
    const key2 = buildEvidenceIdempotencyKey({ ...base, sourceId: 'sub-002' });
    expect(key1).not.toBe(key2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 9: Public DTO (4 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Public mastery DTO', () => {
  const agg = makeAggregate({
    currentState: 'practicing',
    totalOpportunities: 5,
    successfulUses: 3,
    independentUses: 2,
    distinctContextCount: 2,
    confidence: 0.62,
    weightedSuccessScore: 2.5,
    weightedErrorScore: 0.5,
  });

  it('does NOT include evidence_weight field', () => {
    const dto = buildPublicMasteryDTO({
      grammarTopicId: 'grammar.present_simple',
      titlePtBR: 'Presente Simples',
      agg,
    });
    expect(dto).not.toHaveProperty('weightedSuccessScore');
    expect(dto).not.toHaveProperty('weightedErrorScore');
    expect(dto).not.toHaveProperty('evidenceWeight');
  });

  it('does NOT include reason_code', () => {
    const dto = buildPublicMasteryDTO({
      grammarTopicId: 'grammar.present_simple',
      titlePtBR: 'Presente Simples',
      agg,
    });
    expect(dto).not.toHaveProperty('reasonCode');
    expect(dto).not.toHaveProperty('blockedReasons');
  });

  it('does NOT include raw evidence items', () => {
    const dto = buildPublicMasteryDTO({
      grammarTopicId: 'grammar.present_simple',
      titlePtBR: 'Presente Simples',
      agg,
    });
    expect(dto).not.toHaveProperty('evidence');
    expect(dto).not.toHaveProperty('errorCount');
  });

  it('confidence and progress match aggregate', () => {
    const dto = buildPublicMasteryDTO({
      grammarTopicId: 'grammar.present_simple',
      titlePtBR: 'Presente Simples',
      agg,
      lastPracticedAt: '2026-07-01T10:00:00Z',
      maintenanceDueAt: null,
    });
    expect(dto.confidence).toBe(agg.confidence);
    expect(dto.progress.opportunities).toBe(agg.totalOpportunities);
    expect(dto.progress.successfulUses).toBe(agg.successfulUses);
    expect(dto.progress.independentUses).toBe(agg.independentUses);
    expect(dto.progress.distinctContexts).toBe(agg.distinctContextCount);
    expect(dto.lastPracticedAt).toBe('2026-07-01T10:00:00Z');
    expect(dto.maintenanceDueAt).toBeNull();
    expect(dto.state).toBe('practicing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 10: Feature flags (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature flags', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.GRAMMAR_EVIDENCE_ENGINE_V1;
    delete process.env.GRAMMAR_EVIDENCE_ENGINE_V1;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.GRAMMAR_EVIDENCE_ENGINE_V1;
    } else {
      process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = savedEnv;
    }
  });

  it("getGrammarEvidenceEngineMode defaults to 'off' when unset", () => {
    expect(getGrammarEvidenceEngineMode()).toBe('off');
  });

  it('reads GRAMMAR_EVIDENCE_ENGINE_V1 env var', () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'full';
    expect(getGrammarEvidenceEngineMode()).toBe('full');
  });

  it("'shadow' → isGrammarEvidenceEngineShadow() = true", () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'shadow';
    expect(isGrammarEvidenceEngineShadow()).toBe(true);
    expect(isGrammarEvidenceEngineEnabled()).toBe(true);
    expect(isGrammarEvidenceEngineFullyActive()).toBe(false);
  });

  it("'full' → isGrammarEvidenceEngineFullyActive() = true", () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'full';
    expect(isGrammarEvidenceEngineFullyActive()).toBe(true);
    expect(isGrammarEvidenceEngineEnabled()).toBe(true);
  });

  it("'admin' → isGrammarEvidenceEngineFullyActive() = true", () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'admin';
    expect(isGrammarEvidenceEngineFullyActive()).toBe(true);
    expect(isGrammarEvidenceEngineEnabled()).toBe(true);
  });

  it("'off' → isGrammarEvidenceEngineEnabled() = false", () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'off';
    expect(isGrammarEvidenceEngineEnabled()).toBe(false);
    expect(isGrammarEvidenceEngineShadow()).toBe(false);
    expect(isGrammarEvidenceEngineFullyActive()).toBe(false);
  });

  it("'new_users' → isGrammarEvidenceEngineEnabled() = true", () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'new_users';
    expect(isGrammarEvidenceEngineEnabled()).toBe(true);
    expect(isGrammarEvidenceEngineFullyActive()).toBe(true);
  });

  it("unknown value → defaults to 'off'", () => {
    process.env.GRAMMAR_EVIDENCE_ENGINE_V1 = 'invalid_mode';
    expect(getGrammarEvidenceEngineMode()).toBe('off');
    expect(isGrammarEvidenceEngineEnabled()).toBe(false);
  });
});
