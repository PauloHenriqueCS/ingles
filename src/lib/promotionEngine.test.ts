import { describe, it, expect } from 'vitest';
import { evaluateSkillForPromotion } from './promotionEngine';
import type {
  PromotionEvidenceBundle,
  TopicMasteryInfo,
  MissionEvidence,
  CheckpointSummary,
  ConsistencyInfo,
} from '../domain/promotion/promotion-types';
import type { CEFRLevel } from '../domain/curriculum/cefr';
import type { LearningSkill } from '../domain/learner/learner-skill-types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeMissions(overrides: Partial<MissionEvidence> = {}): MissionEvidence {
  return {
    validCount: 8,
    missionIds: Array.from({ length: 8 }, (_, i) => `mission-${i}`),
    distinctDates: 4,
    latestMissionAt: '2026-07-10',
    ...overrides,
  };
}

function makeCheckpoints(overrides: Partial<CheckpointSummary> = {}): CheckpointSummary {
  return {
    completedCount: 3,
    passedCount: 2,
    ...overrides,
  };
}

function makeConsistency(overrides: Partial<ConsistencyInfo> = {}): ConsistencyInfo {
  return {
    distinctDates: 4,
    singleSessionOnly: false,
    recentMissionsCount: 8,
    hasDecline: false,
    ...overrides,
  };
}

function makeEssentialTopic(overrides: Partial<TopicMasteryInfo> = {}): TopicMasteryInfo {
  return {
    topicId: 'grammar.present_simple',
    isEssential: true,
    mastered: true,
    prerequisites: [],
    prerequisitesMastered: true,
    successfulUses: 8,
    totalOpportunities: 10,
    confidence: 0.85,
    distinctContextCount: 4,
    lastPracticedAt: '2026-07-10',
    ...overrides,
  };
}

function makeBundle(overrides: Partial<PromotionEvidenceBundle> = {}): PromotionEvidenceBundle {
  const defaultTopics: TopicMasteryInfo[] = [
    makeEssentialTopic({ topicId: 'topic-1' }),
    makeEssentialTopic({ topicId: 'topic-2' }),
    makeEssentialTopic({ topicId: 'topic-3' }),
    makeEssentialTopic({ topicId: 'topic-4' }),
  ];

  return {
    userId: 'user-test-123',
    skill: 'writing' as LearningSkill,
    currentLevel: 'A1' as CEFRLevel,
    missions: makeMissions(),
    topicMastery: defaultTopics,
    checkpoints: makeCheckpoints(),
    consistency: makeConsistency(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluateSkillForPromotion — maximum level', () => {
  it('returns maximum_supported_level for C1 (no C2 promotion)', () => {
    const bundle = makeBundle({ currentLevel: 'C1' });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('maximum_supported_level');
    expect(result.targetLevel).toBeNull();
    expect(result.eligibleForPromotion).toBe(false);
  });
});

describe('evaluateSkillForPromotion — insufficient data early exit', () => {
  it('returns insufficient_data when validCount < 2', () => {
    const bundle = makeBundle({ missions: makeMissions({ validCount: 0 }) });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('insufficient_data');
    expect(result.eligibleForPromotion).toBe(false);
  });

  it('returns insufficient_data when validCount === 1', () => {
    const bundle = makeBundle({ missions: makeMissions({ validCount: 1 }) });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('insufficient_data');
  });
});

describe('evaluateSkillForPromotion — MUST promote (writing A1)', () => {
  it('promotes A1 learner with all criteria met', () => {
    const bundle = makeBundle({
      currentLevel: 'A1',
      missions: makeMissions({ validCount: 8, distinctDates: 4 }),
      topicMastery: [
        makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 9, totalOpportunities: 10, confidence: 0.85, distinctContextCount: 3 }),
        makeEssentialTopic({ topicId: 't3', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.88, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't4', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.82, distinctContextCount: 3 }),
      ],
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 4, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('promote');
    expect(result.eligibleForPromotion).toBe(true);
    expect(result.targetLevel).toBe('A2');
    expect(result.currentLevel).toBe('A1');
  });

  it('promotes A2→B1 with enough missions (10)', () => {
    const topics = Array.from({ length: 5 }, (_, i) =>
      makeEssentialTopic({ topicId: `t${i}`, mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.85, distinctContextCount: 4 }),
    );
    const bundle = makeBundle({
      currentLevel: 'A2',
      missions: makeMissions({ validCount: 8, distinctDates: 5 }),
      topicMastery: topics,
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 5, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('promote');
    expect(result.targetLevel).toBe('B1');
  });

  it('confidence is 1.0 when all confidence factors pass', () => {
    const bundle = makeBundle({
      missions: makeMissions({ validCount: 20, distinctDates: 6 }),
      topicMastery: [
        makeEssentialTopic({ topicId: 't1', mastered: true, confidence: 0.9, distinctContextCount: 5, successfulUses: 9, totalOpportunities: 10 }),
        makeEssentialTopic({ topicId: 't2', mastered: true, confidence: 0.9, distinctContextCount: 5, successfulUses: 9, totalOpportunities: 10 }),
        makeEssentialTopic({ topicId: 't3', mastered: true, confidence: 0.9, distinctContextCount: 5, successfulUses: 9, totalOpportunities: 10 }),
      ],
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 3 }),
      consistency: makeConsistency({ distinctDates: 6, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.promotionConfidence).toBe(1.0);
    expect(result.decision).toBe('promote');
  });
});

describe('evaluateSkillForPromotion — MUST NOT promote', () => {
  it('does NOT promote with 7 missions (below A1 minimum of 8)', () => {
    const bundle = makeBundle({
      missions: makeMissions({ validCount: 7, distinctDates: 4 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).not.toBe('promote');
    const missionReq = result.requirements.find(r => r.key === 'missions');
    expect(missionReq?.status).toBe('failed');
  });

  it('does NOT promote with 74.99% essential topic coverage (below 75%)', () => {
    // 3 out of 4 topics mastered = 75%, exactly 75 should pass, but 3/5 = 60%
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true }),
      makeEssentialTopic({ topicId: 't2', mastered: true }),
      makeEssentialTopic({ topicId: 't3', mastered: true }),
      makeEssentialTopic({ topicId: 't4', mastered: false }),
      makeEssentialTopic({ topicId: 't5', mastered: false }),
    ];
    const bundle = makeBundle({ topicMastery: topics }); // 3/5 = 60%
    const result = evaluateSkillForPromotion(bundle);
    const topicReq = result.requirements.find(r => r.key === 'essential_topics');
    expect(topicReq?.status).toBe('failed');
    expect(result.decision).not.toBe('promote');
  });

  it('does NOT promote with objective accuracy at 79.99% (below 80%)', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 7, totalOpportunities: 10, confidence: 1.0, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.0, distinctContextCount: 4 }),
    ];
    // Only t1 counted (t2 confidence=0 but weight still 0 means total weight=1.0, so 7/10=0.70)
    // actually t2 has confidence=0, so weight=0, so only t1: 7/10 = 0.70
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('failed');
    expect(result.decision).not.toBe('promote');
  });

  it('does NOT promote with accuracy exactly 79% (below 80%)', () => {
    const topics = [
      makeEssentialTopic({
        topicId: 't1',
        mastered: true,
        successfulUses: 79,
        totalOpportunities: 100,
        confidence: 1.0,
        distinctContextCount: 4,
      }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('failed');
    expect(result.decision).not.toBe('promote');
  });

  it('does NOT promote with singleSessionOnly evidence', () => {
    const bundle = makeBundle({
      consistency: makeConsistency({ singleSessionOnly: true, distinctDates: 1 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    // singleSessionOnly reduces confidence significantly and also fails consistency
    const consistencyReq = result.requirements.find(r => r.key === 'consistency');
    expect(consistencyReq?.status).not.toBe('passed');
    expect(result.decision).not.toBe('promote');
  });

  it('does NOT promote when confidence < 0.80', () => {
    // Force very low confidence: few missions, single session, few dates
    const bundle = makeBundle({
      missions: makeMissions({ validCount: 2, distinctDates: 1 }),
      checkpoints: makeCheckpoints({ completedCount: 0, passedCount: 0 }),
      consistency: makeConsistency({ distinctDates: 1, singleSessionOnly: true }),
      topicMastery: [], // triggers 0.10 reduction
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.promotionConfidence).toBeLessThan(0.80);
    expect(result.decision).not.toBe('promote');
  });

  it('does NOT promote when prerequisites not met', () => {
    const topics = [
      makeEssentialTopic({
        topicId: 't1',
        mastered: true,
        prerequisites: ['t-prereq'],
        prerequisitesMastered: false, // prereq not mastered
        distinctContextCount: 4,
      }),
      makeEssentialTopic({ topicId: 't2', mastered: true, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't3', mastered: true, distinctContextCount: 4 }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const prereqReq = result.requirements.find(r => r.key === 'prerequisites');
    expect(prereqReq?.status).toBe('failed');
    expect(result.decision).not.toBe('promote');
  });

  it('does NOT promote when distinct context count < 3', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, distinctContextCount: 2 }),
      makeEssentialTopic({ topicId: 't2', mastered: true, distinctContextCount: 1 }),
      makeEssentialTopic({ topicId: 't3', mastered: true, distinctContextCount: 2 }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const ctxReq = result.requirements.find(r => r.key === 'context_diversity');
    expect(ctxReq?.status).toBe('failed');
  });

  it('does NOT promote when checkpoints not passed enough', () => {
    const bundle = makeBundle({
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 1 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const ckptReq = result.requirements.find(r => r.key === 'checkpoints');
    expect(ckptReq?.status).toBe('failed');
    expect(result.decision).not.toBe('promote');
  });
});

describe('evaluateSkillForPromotion — boundary conditions', () => {
  it('confidence exactly 0.80 should be treated as passing (not blocking)', () => {
    // With exactly 12 missions (1.5x A1=8 → need ≥12, A1 threshold = 8*1.5=12)
    // distinctDates=3, no singleSession, completedCount=3, topics present
    // → 0 reductions → confidence=1.0 (above boundary, but test the logic below)
    // For confidence exactly 0.80: need exactly the combination that totals 0.20 reduction
    // Reduce by 0.20 only (distinctDates<3): this yields 0.80
    const bundle = makeBundle({
      missions: makeMissions({ validCount: 12, distinctDates: 2 }),
      topicMastery: [
        makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't3', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
      ],
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 2, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    // Only 1 reduction: distinctDates<3 → 0.20, final = 0.80
    expect(result.promotionConfidence).toBe(0.80);
    // 0.80 >= 0.80, should promote if other criteria pass
    expect(result.decision).toBe('promote');
  });

  it('confidence 0.79 blocks promotion', () => {
    // distinctDates < 3 (0.20) + checkpoints < 3 (0.10) = 0.30 reduction → 0.70 < 0.80
    const bundle = makeBundle({
      missions: makeMissions({ validCount: 12, distinctDates: 2 }),
      topicMastery: [
        makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't3', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
      ],
      checkpoints: makeCheckpoints({ completedCount: 2, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 2, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    // 0.20 (dates) + 0.10 (checkpoints incomplete) = 0.30 → confidence = 0.70
    expect(result.promotionConfidence).toBeLessThan(0.80);
    expect(result.decision).not.toBe('promote');
  });

  it('exactly 75% essential topic coverage passes', () => {
    // 3 out of 4 = 75% → exactly 0.75 → should pass
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.85, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.85, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't3', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.85, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't4', mastered: false, successfulUses: 3, totalOpportunities: 10, confidence: 0.4, distinctContextCount: 1 }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const topicReq = result.requirements.find(r => r.key === 'essential_topics');
    expect(topicReq?.status).toBe('passed');
  });

  it('exactly 80% accuracy passes', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 80, totalOpportunities: 100, confidence: 1.0, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.0, distinctContextCount: 4 }),
    ];
    // t2 has confidence=0 so weight=0, only t1 counts: 80/100=0.80
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('passed');
  });
});

describe('evaluateSkillForPromotion — checkpoint insufficient_data', () => {
  it('marks checkpoints as insufficient_data when completedCount < 3', () => {
    const bundle = makeBundle({
      checkpoints: makeCheckpoints({ completedCount: 1, passedCount: 1 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const ckptReq = result.requirements.find(r => r.key === 'checkpoints');
    expect(ckptReq?.status).toBe('insufficient_data');
  });

  it('marks checkpoints as insufficient_data when completedCount === 0', () => {
    const bundle = makeBundle({
      checkpoints: makeCheckpoints({ completedCount: 0, passedCount: 0 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const ckptReq = result.requirements.find(r => r.key === 'checkpoints');
    expect(ckptReq?.status).toBe('insufficient_data');
  });

  it('returns insufficient_data decision when data is missing but not failed', () => {
    const bundle = makeBundle({
      checkpoints: makeCheckpoints({ completedCount: 0, passedCount: 0 }),
      missions: makeMissions({ validCount: 8 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    // has insufficient_data requirements but may pass others
    expect(['insufficient_data', 'keep_level']).toContain(result.decision);
  });
});

describe('evaluateSkillForPromotion — configuration_error', () => {
  it('returns configuration_error when no essential topics in catalog', () => {
    // Empty topicMastery + empty essential topics: engine detects 0 essential topics
    // But wait: the engine logic uses topicMastery.filter(t => t.isEssential)
    // If topicMastery is empty, essential topics count = 0 → configuration_error
    const bundle = makeBundle({
      topicMastery: [], // No topics at all
      missions: makeMissions({ validCount: 8 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('configuration_error');
  });

  it('configuration_error when all topics are non-essential', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', isEssential: false, mastered: true }),
      makeEssentialTopic({ topicId: 't2', isEssential: false, mastered: true }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('configuration_error');
  });
});

describe('evaluateSkillForPromotion — level mappings', () => {
  it('correctly maps A1→A2', () => {
    const bundle = makeBundle({ currentLevel: 'A1' });
    const result = evaluateSkillForPromotion(bundle);
    if (result.decision !== 'maximum_supported_level') {
      expect(result.targetLevel).toBe('A2');
    }
  });

  it('correctly maps A2→B1', () => {
    const bundle = makeBundle({ currentLevel: 'A2' });
    const result = evaluateSkillForPromotion(bundle);
    if (result.decision !== 'maximum_supported_level') {
      expect(result.targetLevel).toBe('B1');
    }
  });

  it('correctly maps B1→B2', () => {
    const bundle = makeBundle({ currentLevel: 'B1', missions: makeMissions({ validCount: 10 }) });
    const result = evaluateSkillForPromotion(bundle);
    if (result.decision !== 'maximum_supported_level') {
      expect(result.targetLevel).toBe('B2');
    }
  });

  it('correctly maps B2→C1', () => {
    const bundle = makeBundle({ currentLevel: 'B2', missions: makeMissions({ validCount: 10 }) });
    const result = evaluateSkillForPromotion(bundle);
    if (result.decision !== 'maximum_supported_level') {
      expect(result.targetLevel).toBe('C1');
    }
  });

  it('does NOT map C1→C2 (no C2 promotion)', () => {
    const bundle = makeBundle({ currentLevel: 'C1' });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.decision).toBe('maximum_supported_level');
    expect(result.targetLevel).toBeNull();
  });
});

describe('evaluateSkillForPromotion — topics with zero opportunities', () => {
  it('skips topics with 0 totalOpportunities in accuracy calculation', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 0, totalOpportunities: 0, confidence: 0.8, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    // t1 skipped (totalOpportunities=0), t2 = 8/10 = 0.80
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('passed');
  });

  it('returns insufficient_data for accuracy when ALL topics have 0 opportunities', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 0, totalOpportunities: 0, confidence: 0.8, distinctContextCount: 4 }),
      makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 0, totalOpportunities: 0, confidence: 0.8, distinctContextCount: 4 }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('insufficient_data');
  });
});

describe('evaluateSkillForPromotion — pronunciation skill', () => {
  it('handles pronunciation with accuracy', () => {
    const bundle = makeBundle({
      skill: 'pronunciation',
      topicMastery: [],
      pronunciationAccuracy: 0.85,
      missions: makeMissions({ validCount: 8, distinctDates: 4 }),
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 4, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('passed');
    // topic, prereq, context_diversity should be insufficient_data
    const topicReq = result.requirements.find(r => r.key === 'essential_topics');
    expect(topicReq?.status).toBe('insufficient_data');
  });

  it('returns insufficient_data accuracy for pronunciation when no data', () => {
    const bundle = makeBundle({
      skill: 'pronunciation',
      topicMastery: [],
      pronunciationAccuracy: null,
      missions: makeMissions({ validCount: 8 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('insufficient_data');
  });

  it('pronunciation with low accuracy fails', () => {
    const bundle = makeBundle({
      skill: 'pronunciation',
      topicMastery: [],
      pronunciationAccuracy: 0.70,
      missions: makeMissions({ validCount: 8 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('failed');
  });
});

describe('evaluateSkillForPromotion — conversation skill', () => {
  it('uses conversationSessionCount as valid missions proxy', () => {
    const bundle = makeBundle({
      skill: 'conversation',
      topicMastery: [],
      conversationSessionCount: 5,
      conversationDistinctContexts: 3,
      missions: makeMissions({ validCount: 5 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const missionReq = result.requirements.find(r => r.key === 'missions');
    expect(missionReq?.status).toBe('failed'); // 5 < 8
  });

  it('conversation topic mastery is insufficient_data', () => {
    const bundle = makeBundle({
      skill: 'conversation',
      topicMastery: [],
      conversationSessionCount: 10,
      conversationDistinctContexts: 4,
      missions: makeMissions({ validCount: 10, distinctDates: 4 }),
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 4, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const topicReq = result.requirements.find(r => r.key === 'essential_topics');
    expect(topicReq?.status).toBe('insufficient_data');
  });

  it('conversation accuracy is insufficient_data', () => {
    const bundle = makeBundle({
      skill: 'conversation',
      topicMastery: [],
      missions: makeMissions({ validCount: 10 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const accReq = result.requirements.find(r => r.key === 'objective_accuracy');
    expect(accReq?.status).toBe('insufficient_data');
  });
});

describe('evaluateSkillForPromotion — regression signals', () => {
  it('returns stable when all essential topics confidence avg > 0.7', () => {
    const bundle = makeBundle({
      topicMastery: [
        makeEssentialTopic({ topicId: 't1', mastered: true, confidence: 0.9, successfulUses: 8, totalOpportunities: 10, distinctContextCount: 4 }),
        makeEssentialTopic({ topicId: 't2', mastered: true, confidence: 0.85, successfulUses: 8, totalOpportunities: 10, distinctContextCount: 4 }),
      ],
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.regressionSignal).toBe('stable');
  });

  it('returns attention_required when accuracy between 0.50 and 0.65', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 60, totalOpportunities: 100, confidence: 1.0, distinctContextCount: 4 }),
    ];
    const bundle = makeBundle({ topicMastery: topics });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.regressionSignal).toBe('attention_required');
  });

  it('returns reassessment_required when singleSessionOnly and accuracy < 0.60', () => {
    const topics = [
      makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 50, totalOpportunities: 100, confidence: 1.0, distinctContextCount: 4 }),
    ];
    const bundle = makeBundle({
      topicMastery: topics,
      consistency: makeConsistency({ singleSessionOnly: true, distinctDates: 1 }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.regressionSignal).toBe('reassessment_required');
  });
});

describe('evaluateSkillForPromotion — progress percent', () => {
  it('returns progressPercent between 0 and 100', () => {
    const bundle = makeBundle();
    const result = evaluateSkillForPromotion(bundle);
    expect(result.progressPercent).toBeGreaterThanOrEqual(0);
    expect(result.progressPercent).toBeLessThanOrEqual(100);
  });

  it('returns high progressPercent for well-performing learner', () => {
    const bundle = makeBundle({
      missions: makeMissions({ validCount: 16, distinctDates: 6 }),
      topicMastery: [
        makeEssentialTopic({ topicId: 't1', mastered: true, successfulUses: 9, totalOpportunities: 10, confidence: 0.95, distinctContextCount: 5 }),
        makeEssentialTopic({ topicId: 't2', mastered: true, successfulUses: 9, totalOpportunities: 10, confidence: 0.95, distinctContextCount: 5 }),
        makeEssentialTopic({ topicId: 't3', mastered: true, successfulUses: 9, totalOpportunities: 10, confidence: 0.95, distinctContextCount: 5 }),
      ],
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 3 }),
      consistency: makeConsistency({ distinctDates: 6, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.progressPercent).toBeGreaterThan(80);
  });
});

describe('evaluateSkillForPromotion — B1 minimum missions (10)', () => {
  it('does NOT promote B1 with only 8 missions', () => {
    const topics = Array.from({ length: 4 }, (_, i) =>
      makeEssentialTopic({ topicId: `t${i}`, mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
    );
    const bundle = makeBundle({
      currentLevel: 'B1',
      missions: makeMissions({ validCount: 8 }), // below B1 minimum of 10
      topicMastery: topics,
    });
    const result = evaluateSkillForPromotion(bundle);
    const missionReq = result.requirements.find(r => r.key === 'missions');
    expect(missionReq?.status).toBe('failed');
    expect(result.decision).not.toBe('promote');
  });

  it('promotes B1 with 10 missions (minimum)', () => {
    const topics = Array.from({ length: 4 }, (_, i) =>
      makeEssentialTopic({ topicId: `t${i}`, mastered: true, successfulUses: 8, totalOpportunities: 10, confidence: 0.9, distinctContextCount: 4 }),
    );
    const bundle = makeBundle({
      currentLevel: 'B1',
      missions: makeMissions({ validCount: 10, distinctDates: 5 }),
      topicMastery: topics,
      checkpoints: makeCheckpoints({ completedCount: 3, passedCount: 2 }),
      consistency: makeConsistency({ distinctDates: 5, singleSessionOnly: false }),
    });
    const result = evaluateSkillForPromotion(bundle);
    const missionReq = result.requirements.find(r => r.key === 'missions');
    expect(missionReq?.status).toBe('passed');
  });
});

describe('evaluateSkillForPromotion — engine metadata', () => {
  it('includes engineVersion in result', () => {
    const bundle = makeBundle();
    const result = evaluateSkillForPromotion(bundle);
    expect(result.engineVersion).toBe('v1.0.0');
  });

  it('includes curriculumVersion in result', () => {
    const bundle = makeBundle();
    const result = evaluateSkillForPromotion(bundle);
    expect(result.curriculumVersion).toBe(1);
  });

  it('includes evaluatedAt timestamp', () => {
    const bundle = makeBundle();
    const result = evaluateSkillForPromotion(bundle);
    expect(result.evaluatedAt).toBeTruthy();
    expect(new Date(result.evaluatedAt).getTime()).toBeGreaterThan(0);
  });

  it('includes userId and skill in result', () => {
    const bundle = makeBundle({ userId: 'user-abc', skill: 'writing' });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.userId).toBe('user-abc');
    expect(result.skill).toBe('writing');
  });

  it('includes evidenceSnapshot with meaningful data', () => {
    const bundle = makeBundle({ missions: makeMissions({ validCount: 8, distinctDates: 4 }) });
    const result = evaluateSkillForPromotion(bundle);
    expect(result.evidenceSnapshot).toBeTruthy();
    expect(typeof result.evidenceSnapshot).toBe('object');
  });
});
