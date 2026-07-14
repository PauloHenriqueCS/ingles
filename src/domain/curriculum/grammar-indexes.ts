import { GrammarTopic, GrammarLearningStage } from './grammar-types';
import { CEFRLevel, cefrIndex } from './cefr';
import { GRAMMAR_CATALOG } from './grammar-catalog';

// Build lookup maps once at module load (lazy singleton pattern)
let _byId: Map<string, GrammarTopic> | null = null;
let _bySlug: Map<string, GrammarTopic> | null = null;

function getById(): Map<string, GrammarTopic> {
  if (!_byId) {
    _byId = new Map(GRAMMAR_CATALOG.map(t => [t.id, t]));
  }
  return _byId;
}

function getBySlug(): Map<string, GrammarTopic> {
  if (!_bySlug) {
    _bySlug = new Map(GRAMMAR_CATALOG.map(t => [t.slug, t]));
  }
  return _bySlug;
}

export function getGrammarTopicById(id: string): GrammarTopic | null {
  return getById().get(id) ?? null;
}

export function getGrammarTopicBySlug(slug: string): GrammarTopic | null {
  return getBySlug().get(slug) ?? null;
}

export function getGrammarTopicsByLevel(level: CEFRLevel): GrammarTopic[] {
  const li = cefrIndex(level);
  return GRAMMAR_CATALOG.filter(t =>
    cefrIndex(t.minimumExposureLevel) <= li &&
    cefrIndex(t.expectedMasteryLevel) >= li
  );
}

export function getTopicsAvailableForExposure(level: CEFRLevel): GrammarTopic[] {
  const li = cefrIndex(level);
  return GRAMMAR_CATALOG.filter(t => cefrIndex(t.minimumExposureLevel) <= li);
}

export function getTopicsAvailableForGuidedPractice(level: CEFRLevel): GrammarTopic[] {
  const li = cefrIndex(level);
  return GRAMMAR_CATALOG.filter(t => cefrIndex(t.minimumGuidedPracticeLevel) <= li);
}

export function getTopicsAvailableForIndependentProduction(level: CEFRLevel): GrammarTopic[] {
  const li = cefrIndex(level);
  return GRAMMAR_CATALOG.filter(t => cefrIndex(t.minimumIndependentProductionLevel) <= li);
}

export function getRequiredPrerequisites(topicId: string): GrammarTopic[] {
  const topic = getGrammarTopicById(topicId);
  if (!topic) return [];
  return topic.prerequisites
    .map(prereqId => getGrammarTopicById(prereqId))
    .filter((t): t is GrammarTopic => t !== null);
}

export function isTopicAvailableAtStage(
  topicId: string,
  level: CEFRLevel,
  stage: GrammarLearningStage,
): boolean {
  const topic = getGrammarTopicById(topicId);
  if (!topic || !topic.isActive) return false;
  const li = cefrIndex(level);
  switch (stage) {
    case 'exposure':             return cefrIndex(topic.minimumExposureLevel) <= li;
    case 'guided_practice':      return cefrIndex(topic.minimumGuidedPracticeLevel) <= li;
    case 'independent_production': return cefrIndex(topic.minimumIndependentProductionLevel) <= li;
    case 'mastery':              return cefrIndex(topic.expectedMasteryLevel) <= li;
  }
}

export function validatePrerequisiteGraph(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(GRAMMAR_CATALOG.map(t => t.id));

  for (const topic of GRAMMAR_CATALOG) {
    for (const prereqId of topic.prerequisites) {
      if (!ids.has(prereqId)) {
        errors.push(`Topic "${topic.id}" has unknown prerequisite "${prereqId}"`);
      }
    }
  }

  // Detect cycles via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const topic = getById().get(id);
    if (topic) {
      for (const prereqId of topic.prerequisites) {
        if (hasCycle(prereqId)) {
          errors.push(`Cycle detected involving "${id}" → "${prereqId}"`);
          return true;
        }
      }
    }
    inStack.delete(id);
    return false;
  }

  for (const topic of GRAMMAR_CATALOG) {
    hasCycle(topic.id);
  }

  return { valid: errors.length === 0, errors };
}
