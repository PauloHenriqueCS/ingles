import { describe, it, expect } from 'vitest';
import { GrammarTopic } from './grammar-types';
import { GRAMMAR_CATALOG } from './grammar-catalog';
import {
  getGrammarTopicById,
  getGrammarTopicBySlug,
  getTopicsAvailableForIndependentProduction,
  getRequiredPrerequisites,
  isTopicAvailableAtStage,
  validatePrerequisiteGraph,
} from './grammar-indexes';
import { validateGrammarCatalog } from './grammar-validation';
import {
  resolveLegacyGrammarTopic,
  isKnownLegacyAlias,
} from './legacy-grammar-aliases';

// ──────────────────────────────────────────────────────────────────────────────
// 1. Unique IDs
// ──────────────────────────────────────────────────────────────────────────────
describe('Unique IDs', () => {
  it('all topic IDs are unique', () => {
    const ids = GRAMMAR_CATALOG.map(t => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Unique slugs
// ──────────────────────────────────────────────────────────────────────────────
describe('Unique slugs', () => {
  it('all slugs are unique', () => {
    const slugs = GRAMMAR_CATALOG.map(t => t.slug);
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(slugs.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. All prerequisites exist
// ──────────────────────────────────────────────────────────────────────────────
describe('All prerequisites exist', () => {
  it('every prerequisite ID refers to an existing topic', () => {
    const ids = new Set(GRAMMAR_CATALOG.map(t => t.id));
    const missingPrereqs: string[] = [];

    for (const topic of GRAMMAR_CATALOG) {
      for (const prereqId of topic.prerequisites) {
        if (!ids.has(prereqId)) {
          missingPrereqs.push(`${topic.id} → ${prereqId}`);
        }
      }
    }

    expect(missingPrereqs).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. No cycles
// ──────────────────────────────────────────────────────────────────────────────
describe('No cycles', () => {
  it('validatePrerequisiteGraph returns no cycle errors', () => {
    const result = validatePrerequisiteGraph();
    const cycleErrors = result.errors.filter(e => e.includes('Cycle'));
    expect(cycleErrors).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. Valid CEFR progression
// ──────────────────────────────────────────────────────────────────────────────
describe('Valid CEFR progression', () => {
  const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

  it('for every topic: exposure <= guided <= production <= mastery', () => {
    const violations: string[] = [];

    for (const topic of GRAMMAR_CATALOG) {
      const exp = CEFR_ORDER.indexOf(topic.minimumExposureLevel);
      const guided = CEFR_ORDER.indexOf(topic.minimumGuidedPracticeLevel);
      const prod = CEFR_ORDER.indexOf(topic.minimumIndependentProductionLevel);
      const mastery = CEFR_ORDER.indexOf(topic.expectedMasteryLevel);

      if (exp > guided) violations.push(`${topic.id}: exposure(${topic.minimumExposureLevel}) > guided(${topic.minimumGuidedPracticeLevel})`);
      if (guided > prod) violations.push(`${topic.id}: guided(${topic.minimumGuidedPracticeLevel}) > production(${topic.minimumIndependentProductionLevel})`);
      if (prod > mastery) violations.push(`${topic.id}: production(${topic.minimumIndependentProductionLevel}) > mastery(${topic.expectedMasteryLevel})`);
    }

    expect(violations).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. Get by ID
// ──────────────────────────────────────────────────────────────────────────────
describe('Get by ID', () => {
  it('returns correct topic for known ID', () => {
    const topic = getGrammarTopicById('grammar.present_simple');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.present_simple');
    expect(topic?.slug).toBe('present-simple');
  });

  it('returns null for unknown ID', () => {
    const topic = getGrammarTopicById('grammar.does_not_exist');
    expect(topic).toBeNull();
  });

  it('returns correct topic for verb to be', () => {
    const topic = getGrammarTopicById('grammar.verb_to_be.present');
    expect(topic).not.toBeNull();
    expect(topic?.category).toBe('verb_form');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. Filter by level and stage
// ──────────────────────────────────────────────────────────────────────────────
describe('Filter by level and stage', () => {
  it('getTopicsAvailableForIndependentProduction("A1") returns only topics with production level A1', () => {
    const a1Topics = getTopicsAvailableForIndependentProduction('A1');
    expect(a1Topics.length).toBeGreaterThan(0);
    for (const topic of a1Topics) {
      expect(['A1']).toContain(topic.minimumIndependentProductionLevel);
    }
  });

  it('getTopicsAvailableForIndependentProduction("B1") returns more topics than A1', () => {
    const a1Topics = getTopicsAvailableForIndependentProduction('A1');
    const b1Topics = getTopicsAvailableForIndependentProduction('B1');
    expect(b1Topics.length).toBeGreaterThan(a1Topics.length);
  });

  it('getTopicsAvailableForIndependentProduction("A2") contains past_simple', () => {
    const a2Topics = getTopicsAvailableForIndependentProduction('A2');
    const ids = a2Topics.map(t => t.id);
    expect(ids).toContain('grammar.past_simple');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. Legacy alias resolution
// ──────────────────────────────────────────────────────────────────────────────
describe('Legacy alias resolution', () => {
  it('resolves "present simple" to grammar.present_simple', () => {
    const topic = resolveLegacyGrammarTopic('present simple');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.present_simple');
  });

  it('resolves "Simple Past" case-insensitively to grammar.past_simple', () => {
    const topic = resolveLegacyGrammarTopic('Simple Past');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.past_simple');
  });

  it('resolves "PRESENT CONTINUOUS" case-insensitively', () => {
    const topic = resolveLegacyGrammarTopic('PRESENT CONTINUOUS');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.present_continuous');
  });

  it('resolves "Past Simple" with capital letters', () => {
    const topic = resolveLegacyGrammarTopic('Past Simple');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.past_simple');
  });

  it('resolves "passive voice"', () => {
    const topic = resolveLegacyGrammarTopic('passive voice');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.passive.present_simple');
  });

  it('resolves "going to" to future.going_to', () => {
    const topic = resolveLegacyGrammarTopic('going to');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.future.going_to');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 9. Unknown alias rejected
// ──────────────────────────────────────────────────────────────────────────────
describe('Unknown alias rejected', () => {
  it('resolveLegacyGrammarTopic("banana grammar") returns null', () => {
    const topic = resolveLegacyGrammarTopic('banana grammar');
    expect(topic).toBeNull();
  });

  it('resolveLegacyGrammarTopic("") returns null', () => {
    const topic = resolveLegacyGrammarTopic('');
    expect(topic).toBeNull();
  });

  it('isKnownLegacyAlias("banana grammar") returns false', () => {
    expect(isKnownLegacyAlias('banana grammar')).toBe(false);
  });

  it('isKnownLegacyAlias("present simple") returns true', () => {
    expect(isKnownLegacyAlias('present simple')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 10. Ambiguous alias returns null
// ──────────────────────────────────────────────────────────────────────────────
describe('Ambiguous alias returns null', () => {
  it('resolveLegacyGrammarTopic("revisão geral") returns null (mapped to null)', () => {
    const topic = resolveLegacyGrammarTopic('revisão geral');
    expect(topic).toBeNull();
  });

  it('isKnownLegacyAlias("revisão geral") returns true (it is a known alias, just maps to null)', () => {
    expect(isKnownLegacyAlias('revisão geral')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 11. A1 independent production has no advanced topics
// ──────────────────────────────────────────────────────────────────────────────
describe('A1 independent production has no advanced topics', () => {
  it('must not include grammar.conditionals.second', () => {
    const a1Topics = getTopicsAvailableForIndependentProduction('A1');
    const ids = a1Topics.map(t => t.id);
    expect(ids).not.toContain('grammar.conditionals.second');
  });

  it('must not include grammar.passive.present_simple', () => {
    const a1Topics = getTopicsAvailableForIndependentProduction('A1');
    const ids = a1Topics.map(t => t.id);
    expect(ids).not.toContain('grammar.passive.present_simple');
  });

  it('must not include grammar.present_perfect.intro', () => {
    const a1Topics = getTopicsAvailableForIndependentProduction('A1');
    const ids = a1Topics.map(t => t.id);
    expect(ids).not.toContain('grammar.present_perfect.intro');
  });

  it('must not include grammar.reported_speech.basic', () => {
    const a1Topics = getTopicsAvailableForIndependentProduction('A1');
    const ids = a1Topics.map(t => t.id);
    expect(ids).not.toContain('grammar.reported_speech.basic');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 12. Present continuous depends on verb to be
// ──────────────────────────────────────────────────────────────────────────────
describe('Present continuous depends on verb to be', () => {
  it('getRequiredPrerequisites("grammar.present_continuous") includes grammar.verb_to_be.present', () => {
    const prereqs = getRequiredPrerequisites('grammar.present_continuous');
    const prereqIds = prereqs.map(t => t.id);
    expect(prereqIds).toContain('grammar.verb_to_be.present');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 13. Present perfect requires prerequisites
// ──────────────────────────────────────────────────────────────────────────────
describe('Present perfect requires prerequisites', () => {
  it('getRequiredPrerequisites("grammar.present_perfect.intro") includes grammar.past_simple', () => {
    const prereqs = getRequiredPrerequisites('grammar.present_perfect.intro');
    const prereqIds = prereqs.map(t => t.id);
    expect(prereqIds).toContain('grammar.past_simple');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 14. Second conditional requires appropriate prerequisites
// ──────────────────────────────────────────────────────────────────────────────
describe('Second conditional requires appropriate prerequisites', () => {
  it('getRequiredPrerequisites("grammar.conditionals.second") includes grammar.past_simple', () => {
    const prereqs = getRequiredPrerequisites('grammar.conditionals.second');
    const prereqIds = prereqs.map(t => t.id);
    expect(prereqIds).toContain('grammar.past_simple');
  });

  it('getRequiredPrerequisites("grammar.conditionals.second") includes grammar.conditionals.first', () => {
    const prereqs = getRequiredPrerequisites('grammar.conditionals.second');
    const prereqIds = prereqs.map(t => t.id);
    expect(prereqIds).toContain('grammar.conditionals.first');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 15. Catalog is immutable
// ──────────────────────────────────────────────────────────────────────────────
describe('Catalog is immutable', () => {
  it('GRAMMAR_CATALOG is frozen — attempting to push throws', () => {
    expect(() => {
      (GRAMMAR_CATALOG as unknown as GrammarTopic[]).push({} as any);
    }).toThrow();
  });

  it('GRAMMAR_CATALOG is frozen — attempting to assign by index throws in strict mode', () => {
    expect(() => {
      (GRAMMAR_CATALOG as unknown as GrammarTopic[])[0] = {} as any;
    }).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 16. validateGrammarCatalog returns valid
// ──────────────────────────────────────────────────────────────────────────────
describe('validateGrammarCatalog', () => {
  it('returns valid with no errors', () => {
    const result = validateGrammarCatalog();
    if (!result.valid) {
      console.error('Validation errors:', result.errors);
    }
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 17. isTopicAvailableAtStage checks
// ──────────────────────────────────────────────────────────────────────────────
describe('isTopicAvailableAtStage', () => {
  it('present_simple at A1 independent_production is true', () => {
    expect(isTopicAvailableAtStage('grammar.present_simple', 'A1', 'independent_production')).toBe(true);
  });

  it('conditionals.second at A1 independent_production is false', () => {
    expect(isTopicAvailableAtStage('grammar.conditionals.second', 'A1', 'independent_production')).toBe(false);
  });

  it('conditionals.second at B1 independent_production is true', () => {
    expect(isTopicAvailableAtStage('grammar.conditionals.second', 'B1', 'independent_production')).toBe(true);
  });

  it('unknown topic returns false', () => {
    expect(isTopicAvailableAtStage('grammar.nonexistent', 'A1', 'exposure')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 18. Total topic count
// ──────────────────────────────────────────────────────────────────────────────
describe('Total topic count', () => {
  it('GRAMMAR_CATALOG.length is at least 80', () => {
    expect(GRAMMAR_CATALOG.length).toBeGreaterThanOrEqual(80);
  });

  it('GRAMMAR_CATALOG has the expected topic breakdown', () => {
    // A1: 20, A2: 17, B1: 15, B2: 16, C1: 13, C2: 6 = 87
    expect(GRAMMAR_CATALOG.length).toBe(87);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 19. Get by slug
// ──────────────────────────────────────────────────────────────────────────────
describe('Get by slug', () => {
  it('returns correct topic for known slug', () => {
    const topic = getGrammarTopicBySlug('present-simple');
    expect(topic).not.toBeNull();
    expect(topic?.id).toBe('grammar.present_simple');
  });

  it('returns null for unknown slug', () => {
    const topic = getGrammarTopicBySlug('does-not-exist');
    expect(topic).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 20. All active topics have examples and communicativeUses
// ──────────────────────────────────────────────────────────────────────────────
describe('Active topic completeness', () => {
  it('all active topics have at least one example', () => {
    const missing = GRAMMAR_CATALOG.filter(t => t.isActive && t.examples.length === 0);
    expect(missing.map(t => t.id)).toEqual([]);
  });

  it('all active topics have at least one communicativeUse', () => {
    const missing = GRAMMAR_CATALOG.filter(t => t.isActive && t.communicativeUses.length === 0);
    expect(missing.map(t => t.id)).toEqual([]);
  });
});
