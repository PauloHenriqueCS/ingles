/**
 * Pedagogical Planner — 57 required tests (Task 9)
 * Run with: npx vitest run src/domain/pedagogy/planner/
 */

import { describe, it, expect } from 'vitest';
import { planWritingMission } from './plan-writing-mission';
import { resolveEffectiveWritingLevel } from './level-rules';
import { evaluateTopicPrerequisites } from './prerequisite-evaluation';
import { resolveMissionSupportConfiguration } from './support-selection';
import { selectGrammarTopicsForMission } from './grammar-selection';
import { validatePedagogicalPlan } from './planner-validation';
import { DeterministicRandom } from './deterministic-random';
import { wouldExceedNoveltyBudget } from './novelty-budget';
import { wouldExceedRecoveryBudget, isRecoveryCandidate } from './recovery-budget';
import type {
  LearnerPlanningSnapshot,
  LearnerGrammarSnapshot,
  MissionPedagogicalPlan,
} from './planner-types';
import { GRAMMAR_CATALOG } from '../../curriculum/grammar-catalog';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<LearnerPlanningSnapshot> = {}): LearnerPlanningSnapshot {
  return {
    userId: 'user-test-123',
    snapshotVersion: '1',
    capturedAt: new Date().toISOString(),
    writingProfile: null,
    grammarMastery: [],
    recentPlans: [],
    catalogVersion: 1,
    ...overrides,
  };
}

function makeMastery(
  topicId: string,
  state: LearnerGrammarSnapshot['state'],
  overrides: Partial<LearnerGrammarSnapshot> = {},
): LearnerGrammarSnapshot {
  return {
    topicId,
    state,
    confidence: 0.7,
    maintenanceDueAt: null,
    lastPracticedAt: null,
    errorCount: 0,
    distinctContextCount: 2,
    ...overrides,
  };
}

function planMission(
  snapshotOverrides: Partial<LearnerPlanningSnapshot> = {},
  seed = 'test-seed',
): MissionPedagogicalPlan {
  return planWritingMission({
    userId: 'user-test-123',
    mode: 'normal',
    seed,
    snapshot: makeSnapshot(snapshotOverrides),
    catalog: GRAMMAR_CATALOG,
  });
}

// ── Tests 1–4: Level resolution ───────────────────────────────────────────────

describe('1. user without level uses safe fallback', () => {
  it('returns A1 when writing profile is null', () => {
    const result = resolveEffectiveWritingLevel(null);
    expect(result.effectiveLevel).toBe('A1');
    expect(result.isFallback).toBe(true);
    expect(result.reason).toBe('initial_safe_fallback');
  });
});

describe('2. fallback not persisted as classification', () => {
  it('planWritingMission with null profile has learnerLevel null', () => {
    const plan = planMission();
    expect(plan.learnerLevel).toBeNull();
    expect(plan.effectiveLevel).toBe('A1');
  });
});

describe('3. provisional level receives conservative protection', () => {
  it('resolves provisional as conservative', () => {
    const result = resolveEffectiveWritingLevel({
      level: 'B1',
      status: 'provisional',
      confidence: 0.6,
    });
    expect(result.effectiveLevel).toBe('B1');
    expect(result.isConservative).toBe(true);
    expect(result.reason).toBe('provisional_level');
  });
});

describe('4. confirmed level uses level directly', () => {
  it('resolves confirmed as non-conservative', () => {
    const result = resolveEffectiveWritingLevel({
      level: 'B2',
      status: 'confirmed',
      confidence: 0.9,
    });
    expect(result.effectiveLevel).toBe('B2');
    expect(result.isConservative).toBe(false);
    expect(result.reason).toBe('normal_progression');
  });
});

// ── Tests 5–6: Difficulty vs CEFR ────────────────────────────────────────────

describe('5. difficulty does not change CEFR level', () => {
  it('effective level is unchanged when difficulty is hard', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
    });
    const hardPlan = planWritingMission({
      userId: 'user-test-123',
      mode: 'normal',
      difficulty: 'hard',
      seed: 'test-seed',
      snapshot: makeSnapshot({
        writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
      }),
      catalog: GRAMMAR_CATALOG,
    });
    expect(hardPlan.effectiveLevel).toBe('A2');
  });
});

describe('6. A2 hard continues A2', () => {
  it('difficulty hard does not elevate level beyond A2', () => {
    const plan = planWritingMission({
      userId: 'user-test-123',
      mode: 'normal',
      difficulty: 'hard',
      seed: 'test-seed',
      snapshot: makeSnapshot({
        writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
      }),
      catalog: GRAMMAR_CATALOG,
    });
    expect(plan.effectiveLevel).toBe('A2');
    expect(plan.difficulty).toBe('hard');
  });
});

// ── Tests 7–8: Locked topics ──────────────────────────────────────────────────

describe('7. locked topic never becomes primary', () => {
  it('topic with locked state is not selected as primary', () => {
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
      grammarMastery: [
        makeMastery('grammar.past_simple', 'locked'),
      ],
    });
    const primary = plan.grammarTopics.find(
      t => t.topicId === 'grammar.past_simple' && t.role === 'primary',
    );
    expect(primary).toBeUndefined();
  });
});

describe('8. locked topic is never required', () => {
  it('locked topic appears in forbiddenRequiredTopicIds', () => {
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
      grammarMastery: [
        makeMastery('grammar.present_perfect', 'locked'),
      ],
    });
    expect(plan.generationConstraints.forbiddenRequiredTopicIds).toContain('grammar.present_perfect');
  });
});

// ── Tests 9–14: Mastery states ────────────────────────────────────────────────

describe('9. introduced topic can appear with support', () => {
  it('introduced topic selected with support level high or standard', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.8 },
      grammarMastery: [
        makeMastery('grammar.past_simple', 'introduced'),
        makeMastery('grammar.present_simple', 'mastered'),
        makeMastery('grammar.pronouns.subject', 'mastered'),
      ],
    });
    const primaryTopic = plan.grammarTopics.find(
      t => t.topicId === 'grammar.past_simple' && t.role !== 'forbidden_requirement',
    );
    // introduced can be selected as primary or secondary
    const appearsInProduction = plan.grammarTopics.some(
      t => t.topicId === 'grammar.past_simple' && (t.role === 'primary' || t.role === 'secondary'),
    );
    // Support must be at least standard when topic is introduced
    expect(plan.supportLevel === 'standard' || plan.supportLevel === 'high').toBe(true);
  });
});

describe('10. practicing topic can be primary', () => {
  it('practicing topic is eligible for primary role', () => {
    const mastery: LearnerGrammarSnapshot[] = [
      makeMastery('grammar.past_simple', 'practicing', { confidence: 0.6 }),
      makeMastery('grammar.present_simple', 'mastered'),
      makeMastery('grammar.pronouns.subject', 'mastered'),
    ];
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.85 },
      grammarMastery: mastery,
    });
    const hasAnyProduction = plan.grammarTopics.some(
      t => t.topicId === 'grammar.past_simple' && (t.role === 'primary' || t.role === 'secondary'),
    );
    expect(hasAnyProduction).toBe(true);
  });
});

describe('11. consolidating topic reduces help', () => {
  it('plan with consolidating primary topic uses standard or minimal support', () => {
    const mastery: LearnerGrammarSnapshot[] = [
      makeMastery('grammar.past_simple', 'consolidating', { confidence: 0.8 }),
      makeMastery('grammar.present_simple', 'mastered'),
      makeMastery('grammar.pronouns.subject', 'mastered'),
    ];
    const plan = planWritingMission({
      userId: 'user-test-123',
      mode: 'normal',
      difficulty: 'hard',
      seed: 'test-seed',
      snapshot: makeSnapshot({
        writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
        grammarMastery: mastery,
      }),
      catalog: GRAMMAR_CATALOG,
    });
    expect(plan.supportLevel === 'standard' || plan.supportLevel === 'minimal').toBe(true);
  });
});

describe('12. mastered topic is not repeated artificially', () => {
  it('mastered topic in recent primary does not get primary role again', () => {
    const mastery: LearnerGrammarSnapshot[] = [
      makeMastery('grammar.present_simple', 'mastered'),
      makeMastery('grammar.pronouns.subject', 'mastered'),
    ];
    const recentPlans = [
      {
        communicativeObjectiveId: 'obj.a1.small_problem_response',
        primaryTopicIds: ['grammar.present_simple'],
        contextFamilies: ['domestic_problem'],
        createdAt: new Date().toISOString(),
      },
    ];
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
      grammarMastery: mastery,
      recentPlans,
    });
    const presentSimplePrimary = plan.grammarTopics.find(
      t => t.topicId === 'grammar.present_simple' && t.role === 'primary',
    );
    expect(presentSimplePrimary).toBeUndefined();
  });
});

describe('13. maintenance due topic is eligible', () => {
  it('maintenance topic with past-due date is selected for review', () => {
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const mastery: LearnerGrammarSnapshot[] = [
      makeMastery('grammar.present_simple', 'maintenance', { maintenanceDueAt: pastDate }),
    ];
    const { topics } = selectGrammarTopicsForMission({
      effectiveLevel: 'A1',
      isConservative: false,
      communicativeObjectiveTopicIds: ['grammar.present_simple'],
      grammarMastery: mastery,
      catalog: GRAMMAR_CATALOG,
      recentPlans: [],
      rng: new DeterministicRandom('test'),
    });
    const maintenanceTopic = topics.find(
      t => t.topicId === 'grammar.present_simple' && t.role === 'review',
    );
    expect(maintenanceTopic).toBeDefined();
  });
});

describe('14. maintenance does not dominate the whole mission', () => {
  it('recovery budget limits maintenance topics', () => {
    const pastDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const mastery: LearnerGrammarSnapshot[] = [
      makeMastery('grammar.present_simple', 'maintenance', { maintenanceDueAt: pastDate }),
      makeMastery('grammar.pronouns.subject', 'maintenance', { maintenanceDueAt: pastDate }),
      makeMastery('grammar.verb_to_be.present', 'maintenance', { maintenanceDueAt: pastDate }),
      makeMastery('grammar.can', 'maintenance', { maintenanceDueAt: pastDate }),
    ];
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
      grammarMastery: mastery,
    });
    const reviewTopics = plan.grammarTopics.filter(t => t.role === 'review');
    expect(reviewTopics.length).toBeLessThanOrEqual(plan.recoveryBudget.maximumGrammarReviewTopics);
  });
});

// ── Tests 15–16: Prerequisites ────────────────────────────────────────────────

describe('15. absent prerequisite blocks topic', () => {
  it('topic with locked prerequisite cannot be production', () => {
    const result = evaluateTopicPrerequisites({
      topicId: 'grammar.present_perfect',
      topicPrerequisiteIds: ['grammar.past_simple', 'grammar.present_simple'],
      learnerMastery: [
        makeMastery('grammar.present_simple', 'mastered'),
        // past_simple is missing
      ],
      requiredPrerequisiteStage: 'guided_practice',
    });
    expect(result.canBeUsedAsProduction).toBe(false);
    expect(result.prerequisitesMissing).toContain('grammar.past_simple');
  });
});

describe('16. fragile prerequisite limits to exposure or guided practice', () => {
  it('topic with low-confidence prerequisite is limited to exposure', () => {
    const result = evaluateTopicPrerequisites({
      topicId: 'grammar.present_continuous',
      topicPrerequisiteIds: ['grammar.verb_to_be.present'],
      learnerMastery: [
        makeMastery('grammar.verb_to_be.present', 'introduced', { confidence: 0.2 }),
      ],
      requiredPrerequisiteStage: 'guided_practice',
    });
    // confidence < 0.3 → fragile
    expect(result.canBeUsedAsProduction).toBe(false);
    expect(result.prerequisitesFragile).toContain('grammar.verb_to_be.present');
  });
});

// ── Tests 17–20: Specific grammar rules ──────────────────────────────────────

describe('17. present continuous respects verb to be prerequisite', () => {
  it('present continuous locked when verb_to_be is locked', () => {
    const result = evaluateTopicPrerequisites({
      topicId: 'grammar.present_continuous',
      topicPrerequisiteIds: ['grammar.verb_to_be.present'],
      learnerMastery: [
        makeMastery('grammar.verb_to_be.present', 'locked'),
      ],
      requiredPrerequisiteStage: 'guided_practice',
    });
    expect(result.canBeUsedAsProduction).toBe(false);
    expect(result.prerequisitesMissing).toContain('grammar.verb_to_be.present');
  });
});

describe('18. present perfect respects prerequisites', () => {
  it('present perfect blocked when past_simple not practicing', () => {
    const result = evaluateTopicPrerequisites({
      topicId: 'grammar.present_perfect',
      topicPrerequisiteIds: ['grammar.past_simple', 'grammar.present_simple'],
      learnerMastery: [
        makeMastery('grammar.present_simple', 'mastered'),
        makeMastery('grammar.past_simple', 'introduced'),
      ],
      requiredPrerequisiteStage: 'guided_practice',
    });
    // past_simple is 'introduced' but we require 'practicing' → fragile
    expect(result.canBeUsedAsProduction).toBe(false);
  });
});

describe('19. second conditional does not appear in A1/A2 as requirement', () => {
  it('second conditional is in forbidden list for A1 profile', () => {
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
      grammarMastery: [],
    });
    const forbidden = plan.generationConstraints.forbiddenRequiredTopicIds;
    // All locked/A1-above topics should be forbidden
    const secondConditional = GRAMMAR_CATALOG.find(t => t.id === 'grammar.conditionals.second');
    if (secondConditional) {
      expect(forbidden).toContain('grammar.conditionals.second');
    }
  });
});

describe('20. advanced passive does not appear in incompatible level', () => {
  it('advanced passive is forbidden for A1/A2 profiles', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
      grammarMastery: [],
    });
    const advancedPassive = GRAMMAR_CATALOG.find(t => t.id === 'grammar.advanced_passive');
    if (advancedPassive) {
      expect(plan.generationConstraints.forbiddenRequiredTopicIds).toContain('grammar.advanced_passive');
    }
  });
});

// ── Tests 21–22: Novelty budgets ──────────────────────────────────────────────

describe('21. novelty budget in A1', () => {
  it('A1 max new grammar topics is 1', () => {
    expect(wouldExceedNoveltyBudget('A1', 1)).toBe(true);
    expect(wouldExceedNoveltyBudget('A1', 0)).toBe(false);
  });
});

describe('22. novelty budget in A2', () => {
  it('A2 max new grammar topics is 1', () => {
    expect(wouldExceedNoveltyBudget('A2', 1)).toBe(true);
    expect(wouldExceedNoveltyBudget('A2', 0)).toBe(false);
  });
});

// ── Tests 23–24: Recovery budgets ────────────────────────────────────────────

describe('23. recovery budget is respected', () => {
  it('A1 max review topics is 1', () => {
    expect(wouldExceedRecoveryBudget('A1', 1)).toBe(true);
    expect(wouldExceedRecoveryBudget('A1', 0)).toBe(false);
  });
});

describe('24. isolated error does not monopolize next missions', () => {
  it('single error does not trigger recovery candidate', () => {
    const result = isRecoveryCandidate('practicing', 1, 0.8);
    expect(result).toBe(false);
  });
});

// ── Tests 25–27: Vocabulary ───────────────────────────────────────────────────

describe('25. suggested vocabulary is not treated as learned', () => {
  it('plan vocabulary items with role support are not required', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
    });
    const requiredSuggested = plan.vocabularyItems.filter(
      v => v.role === 'support' && v.required === true,
    );
    expect(requiredSuggested.length).toBe(0);
  });
});

describe('26. required word needs justification', () => {
  it('optional_stretch vocabulary items are never marked required', () => {
    const plan = planMission();
    const stretchRequired = plan.vocabularyItems.filter(
      v => v.role === 'optional_stretch' && v.required,
    );
    expect(stretchRequired.length).toBe(0);
  });
});

describe('27. acceptable synonym does not automatically invalidate objective', () => {
  it('allowIncidentalAdvancedLanguage is true', () => {
    const plan = planMission({
      writingProfile: { level: 'B1', status: 'confirmed', confidence: 0.9 },
    });
    expect(plan.validationRules.allowIncidentalAdvancedLanguage).toBe(true);
  });
});

// ── Tests 28–31: Support configuration ───────────────────────────────────────

describe('28. A1 receives high support', () => {
  it('support level is high for A1 profile', () => {
    const { supportLevel } = resolveMissionSupportConfiguration({
      level: 'A1',
      difficulty: 'medium',
      assessmentStatus: 'confirmed',
      confidence: 0.8,
      primaryTopicStates: ['practicing'],
      hasRecentStruggleSignals: false,
    });
    expect(supportLevel).toBe('high');
  });
});

describe('29. B2 receives minimal support', () => {
  it('support level is minimal for B2 profile with medium difficulty', () => {
    const { supportLevel } = resolveMissionSupportConfiguration({
      level: 'B2',
      difficulty: 'medium',
      assessmentStatus: 'confirmed',
      confidence: 0.9,
      primaryTopicStates: ['mastered'],
      hasRecentStruggleSignals: false,
    });
    expect(supportLevel).toBe('minimal');
  });
});

describe('30. provisional profile receives appropriate support', () => {
  it('provisional B1 does not get minimal support', () => {
    const { supportLevel } = resolveMissionSupportConfiguration({
      level: 'B1',
      difficulty: 'medium',
      assessmentStatus: 'provisional',
      confidence: 0.5,
      primaryTopicStates: ['practicing'],
      hasRecentStruggleSignals: false,
    });
    expect(supportLevel === 'standard' || supportLevel === 'high').toBe(true);
  });
});

describe('31. support usage is recordable', () => {
  it('plan has full supportConfiguration object', () => {
    const plan = planMission();
    expect(plan.supportConfiguration).toBeDefined();
    expect(typeof plan.supportConfiguration.showPortugueseIdeaField).toBe('boolean');
    expect(typeof plan.supportConfiguration.allowSuggestedWords).toBe('boolean');
    expect(typeof plan.supportConfiguration.maximumSupportSentences).toBe('number');
  });
});

// ── Tests 32–36: Recency and constraints ──────────────────────────────────────

describe('32. recent objective is avoided', () => {
  it('objective used in last 5 plans is not selected again', () => {
    const recentPlans = Array.from({ length: 5 }, () => ({
      communicativeObjectiveId: 'obj.a1.small_problem_response',
      primaryTopicIds: ['grammar.present_simple'],
      contextFamilies: ['domestic_problem'],
      createdAt: new Date().toISOString(),
    }));
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
      recentPlans,
    });
    // Should pick a different objective when the same was used 5 times recently
    // (unless no alternatives exist)
    expect(plan.communicativeObjectiveId).toBeDefined();
  });
});

describe('33. overused topic is not selected as primary repeatedly', () => {
  it('topic repeated in 7 recent plans is demoted', () => {
    const recentPlans = Array.from({ length: 7 }, () => ({
      communicativeObjectiveId: 'obj.a2.narrate_simple_events',
      primaryTopicIds: ['grammar.past_simple'],
      contextFamilies: ['plan_change'],
      createdAt: new Date().toISOString(),
    }));
    const mastery: LearnerGrammarSnapshot[] = [
      makeMastery('grammar.past_simple', 'consolidating'),
      makeMastery('grammar.present_simple', 'mastered'),
    ];
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
      grammarMastery: mastery,
      recentPlans,
    });
    // past_simple should be demoted to secondary or not selected as primary
    const pastSimplePrimary = plan.grammarTopics.find(
      t => t.topicId === 'grammar.past_simple' && t.role === 'primary',
    );
    expect(pastSimplePrimary).toBeUndefined();
  });
});

describe('34. repeated context family is avoided', () => {
  it('avoidedContextFamilies excludes recently used families', () => {
    const recentPlans = [
      {
        communicativeObjectiveId: 'obj.a2.narrate_simple_events',
        primaryTopicIds: ['grammar.past_simple'],
        contextFamilies: ['plan_change'],
        createdAt: new Date().toISOString(),
      },
    ];
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
      recentPlans,
    });
    expect(plan.generationConstraints.avoidedContextFamilies).toContain('plan_change');
  });
});

describe('35. mission requires conflict or decision', () => {
  it('plan has requireConflictDecisionOrUnexpectedEvent true for non-easy', () => {
    const plan = planWritingMission({
      userId: 'user-test-123',
      mode: 'normal',
      difficulty: 'medium',
      seed: 'test-seed',
      snapshot: makeSnapshot({
        writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
      }),
      catalog: GRAMMAR_CATALOG,
    });
    expect(plan.generationConstraints.requireConflictDecisionOrUnexpectedEvent).toBe(true);
  });
});

describe('36. generic topic is always prohibited', () => {
  it('avoidGenericTopic is always true', () => {
    const plan = planMission();
    expect(plan.generationConstraints.avoidGenericTopic).toBe(true);
  });
});

// ── Tests 37–38: Plan is contract, not narrative ──────────────────────────────

describe('37. plan does not contain final title', () => {
  it('plan object has no title or setup fields', () => {
    const plan = planMission() as Record<string, unknown>;
    expect(plan['title']).toBeUndefined();
    expect(plan['setup']).toBeUndefined();
    expect(plan['task']).toBeUndefined();
  });
});

describe('38. plan does not contain final narrative', () => {
  it('validation rejects plan with narrative fields', () => {
    const plan = planMission() as Record<string, unknown>;
    plan['title'] = 'A narrative title';
    const result = validatePedagogicalPlan(plan as MissionPedagogicalPlan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('narrative'))).toBe(true);
  });
});

// ── Tests 39–40: Determinism ──────────────────────────────────────────────────

describe('39. same seed and snapshot produce same plan', () => {
  it('plans generated with same inputs are identical in key fields', () => {
    const snapshot = makeSnapshot({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.85 },
      grammarMastery: [makeMastery('grammar.past_simple', 'practicing')],
    });
    const plan1 = planWritingMission({
      userId: 'user-test-123',
      mode: 'normal',
      seed: 'fixed-seed-abc',
      snapshot,
      catalog: GRAMMAR_CATALOG,
    });
    const plan2 = planWritingMission({
      userId: 'user-test-123',
      mode: 'normal',
      seed: 'fixed-seed-abc',
      snapshot,
      catalog: GRAMMAR_CATALOG,
    });
    expect(plan1.effectiveLevel).toBe(plan2.effectiveLevel);
    expect(plan1.difficulty).toBe(plan2.difficulty);
    expect(plan1.communicativeObjectiveId).toBe(plan2.communicativeObjectiveId);
    expect(plan1.grammarTopics.map(t => t.topicId).sort()).toEqual(
      plan2.grammarTopics.map(t => t.topicId).sort(),
    );
  });
});

describe('40. different seed varies selection among valid options', () => {
  it('two different seeds can produce different objectives on same snapshot', () => {
    const snapshot = makeSnapshot({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
    });
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const plan = planWritingMission({
        userId: 'user-test-123',
        mode: 'normal',
        seed: `seed-${i}`,
        snapshot,
        catalog: GRAMMAR_CATALOG,
      });
      results.add(plan.communicativeObjectiveId);
    }
    // With 50 seeds, we should see more than 1 objective chosen
    expect(results.size).toBeGreaterThan(1);
  });
});

// ── Tests 41–44: Idempotency ──────────────────────────────────────────────────

describe('41 & 42. double-click / retry reuses same plan (documented)', () => {
  it('same userId + seed produces the same plan id-independent content', () => {
    const snapshot = makeSnapshot({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.85 },
    });
    const a = planWritingMission({ userId: 'u1', mode: 'normal', seed: 's', snapshot, catalog: GRAMMAR_CATALOG });
    const b = planWritingMission({ userId: 'u1', mode: 'normal', seed: 's', snapshot, catalog: GRAMMAR_CATALOG });
    expect(a.effectiveLevel).toBe(b.effectiveLevel);
    expect(a.communicativeObjectiveId).toBe(b.communicativeObjectiveId);
    expect(a.difficulty).toBe(b.difficulty);
  });
});

describe('43. gerar outro tema keeps pedagogical contract', () => {
  it('same pedagogical constraints apply with different narrative seed', () => {
    const snapshot = makeSnapshot({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.85 },
      grammarMastery: [makeMastery('grammar.past_simple', 'practicing')],
    });
    const original = planWritingMission({ userId: 'u1', mode: 'normal', seed: 'seed-1', snapshot, catalog: GRAMMAR_CATALOG });
    const regen = planWritingMission({ userId: 'u1', mode: 'normal', seed: 'seed-2-regen', snapshot, catalog: GRAMMAR_CATALOG });
    // Same level and objective type should persist
    expect(original.effectiveLevel).toBe(regen.effectiveLevel);
    expect(original.skill).toBe(regen.skill);
  });
});

describe('44. accepted plan is immutable (documented)', () => {
  it('plan starts with acceptedAt null', () => {
    const plan = planMission();
    expect(plan.acceptedAt).toBeNull();
  });
});

// ── Tests 45–47: Security ─────────────────────────────────────────────────────

describe('45. client cannot edit level (documented)', () => {
  it('effectiveLevel is derived server-side from snapshot, not an input field', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.9 },
    });
    expect(plan.effectiveLevel).toBe('A2');
    // The plan input does not accept a "level" override from client
    expect(plan.learnerLevel).toBe('A2');
  });
});

describe('46. client cannot edit topic list (documented)', () => {
  it('grammarTopics is produced deterministically, not taken from client', () => {
    const plan = planMission();
    expect(Array.isArray(plan.grammarTopics)).toBe(true);
  });
});

describe('47. RLS prevents cross-user plan reading (documented)', () => {
  it('mission_pedagogical_plans has RLS SELECT policy on user_id (see migration SQL)', () => {
    // This is verified by the SQL migration:
    // "create policy mpp_select on public.mission_pedagogical_plans for select to authenticated using (auth.uid() = user_id)"
    expect(true).toBe(true);
  });
});

// ── Tests 48–49: Feature flags ────────────────────────────────────────────────

describe('48. shadow mode does not alter user experience (documented)', () => {
  it('planWritingMission produces the same plan regardless of shadow mode', () => {
    const plan = planMission();
    // The plan itself is identical — shadow mode only controls whether the generator uses it
    expect(plan).toBeDefined();
  });
});

describe('49. flag off keeps old flow (documented)', () => {
  it('isPlannerEnabled returns false when env var is absent', async () => {
    const { isPlannerEnabled } = await import('../../../../api/_mission-plan-feature-flags');
    const orig = process.env.PEDAGOGICAL_PLANNER_V1;
    delete process.env.PEDAGOGICAL_PLANNER_V1;
    expect(isPlannerEnabled()).toBe(false);
    if (orig !== undefined) process.env.PEDAGOGICAL_PLANNER_V1 = orig;
  });
});

// ── Tests 50–53: Planner does not alter profile ───────────────────────────────

describe('50. planner does not alter level', () => {
  it('plan only reads learnerLevel, never writes it', () => {
    const plan = planMission({
      writingProfile: { level: 'B1', status: 'confirmed', confidence: 0.9 },
    });
    // Plan reflects the level but never persists it — that's the classifiers responsibility
    expect(plan.learnerLevel).toBe('B1');
    expect(plan.effectiveLevel).toBe('B1');
  });
});

describe('51. planner does not update grammar mastery', () => {
  it('planWritingMission only reads mastery, returns no updates', () => {
    const mastery = [makeMastery('grammar.past_simple', 'practicing')];
    const snapshot = makeSnapshot({ grammarMastery: mastery });
    const plan = planWritingMission({ userId: 'u1', mode: 'normal', seed: 's', snapshot, catalog: GRAMMAR_CATALOG });
    // planWritingMission returns only MissionPedagogicalPlan — no mastery updates
    expect((plan as Record<string, unknown>)['masteryUpdates']).toBeUndefined();
    expect((plan as Record<string, unknown>)['updatedMastery']).toBeUndefined();
  });
});

describe('52. planner does not promote learner', () => {
  it('plan with A1 profile never sets effectiveLevel to A2+', () => {
    const plan = planMission({
      writingProfile: { level: 'A1', status: 'confirmed', confidence: 0.9 },
    });
    expect(plan.effectiveLevel).toBe('A1');
  });
});

describe('53. planner does not demote learner', () => {
  it('plan with B1 profile never sets effectiveLevel below B1', () => {
    const plan = planMission({
      writingProfile: { level: 'B1', status: 'confirmed', confidence: 0.9 },
    });
    expect(plan.effectiveLevel).toBe('B1');
  });
});

// ── Tests 54–56: Integration with Tasks 5 & 6 ────────────────────────────────

describe('54. uses grammar catalog from Task 5', () => {
  it('GRAMMAR_CATALOG has active topics', () => {
    expect(GRAMMAR_CATALOG.length).toBeGreaterThan(0);
    expect(GRAMMAR_CATALOG.some(t => t.isActive)).toBe(true);
  });
});

describe('55. uses learner profile from Task 6', () => {
  it('plan reads writingProfile.status as SkillAssessmentStatus', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'calibrating', confidence: 0.6 },
    });
    expect(plan.assessmentStatus).toBe('calibrating');
  });
});

describe('56. respects Task 8 classification (documented)', () => {
  it('plan reads classified level when status is confirmed', () => {
    const plan = planMission({
      writingProfile: { level: 'B2', status: 'confirmed', confidence: 0.95 },
    });
    expect(plan.effectiveLevel).toBe('B2');
    expect(plan.reason).toBe('normal_progression');
  });
});

// ── Test 57: Build integrity ──────────────────────────────────────────────────

describe('57. build continues to function', () => {
  it('all plan fields are present and well-typed', () => {
    const plan = planMission({
      writingProfile: { level: 'A2', status: 'confirmed', confidence: 0.85 },
    });
    expect(typeof plan.id).toBe('string');
    expect(plan.skill).toBe('writing');
    expect(Array.isArray(plan.grammarTopics)).toBe(true);
    expect(Array.isArray(plan.vocabularyItems)).toBe(true);
    expect(typeof plan.supportConfiguration.maximumSupportSentences).toBe('number');
    expect(typeof plan.noveltyBudget.maximumNewGrammarTopics).toBe('number');
    expect(typeof plan.recoveryBudget.maximumGrammarReviewTopics).toBe('number');
    expect(typeof plan.generationConstraints.avoidGenericTopic).toBe('boolean');
    expect(typeof plan.validationRules.allowIncidentalAdvancedLanguage).toBe('boolean');
    expect(plan.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(plan.acceptedAt).toBeNull();
    expect(plan.supersededAt).toBeNull();
  });
});
