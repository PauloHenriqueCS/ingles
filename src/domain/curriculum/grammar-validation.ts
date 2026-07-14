import { GrammarTopic } from './grammar-types';
import { CEFRLevel, cefrIndex } from './cefr';
import { GRAMMAR_CATALOG } from './grammar-catalog';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const ID_PATTERN = /^grammar\.[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const CEFR_ORDER: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function cefrOk(level: unknown): level is CEFRLevel {
  return CEFR_ORDER.includes(level as CEFRLevel);
}

export function validateGrammarCatalog(topics: readonly GrammarTopic[] = GRAMMAR_CATALOG): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const topicMap = new Map<string, GrammarTopic>(topics.map(t => [t.id, t]));

  for (const topic of topics) {
    // Duplicate IDs
    if (ids.has(topic.id)) {
      errors.push(`Duplicate ID: "${topic.id}"`);
    } else {
      ids.add(topic.id);
    }

    // Duplicate slugs
    if (slugs.has(topic.slug)) {
      errors.push(`Duplicate slug: "${topic.slug}"`);
    } else {
      slugs.add(topic.slug);
    }

    // ID format
    if (!ID_PATTERN.test(topic.id)) {
      errors.push(`Invalid ID format: "${topic.id}" (must match grammar.<segment>.<segment>...)`);
    }

    // Category present
    if (!topic.category) {
      errors.push(`Topic "${topic.id}" has no category`);
    }

    // CEFR level validity
    for (const lvl of [topic.minimumExposureLevel, topic.minimumGuidedPracticeLevel, topic.minimumIndependentProductionLevel, topic.expectedMasteryLevel]) {
      if (!cefrOk(lvl)) {
        errors.push(`Topic "${topic.id}" has invalid CEFR level: "${lvl}"`);
      }
    }

    // CEFR progression: exposure <= guided <= production <= mastery
    const exp = cefrIndex(topic.minimumExposureLevel);
    const guided = cefrIndex(topic.minimumGuidedPracticeLevel);
    const prod = cefrIndex(topic.minimumIndependentProductionLevel);
    const mastery = cefrIndex(topic.expectedMasteryLevel);

    if (exp > guided) {
      errors.push(`Topic "${topic.id}": minimumExposureLevel (${topic.minimumExposureLevel}) > minimumGuidedPracticeLevel (${topic.minimumGuidedPracticeLevel})`);
    }
    if (guided > prod) {
      errors.push(`Topic "${topic.id}": minimumGuidedPracticeLevel (${topic.minimumGuidedPracticeLevel}) > minimumIndependentProductionLevel (${topic.minimumIndependentProductionLevel})`);
    }
    if (prod > mastery) {
      errors.push(`Topic "${topic.id}": minimumIndependentProductionLevel (${topic.minimumIndependentProductionLevel}) > expectedMasteryLevel (${topic.expectedMasteryLevel})`);
    }

    // Prerequisites exist
    for (const prereqId of topic.prerequisites) {
      if (!topicMap.has(prereqId)) {
        errors.push(`Topic "${topic.id}" has unknown prerequisite "${prereqId}"`);
      }
    }

    // relatedTopics references exist
    for (const relId of topic.relatedTopics) {
      if (!topicMap.has(relId)) {
        warnings.push(`Topic "${topic.id}" has unknown relatedTopic "${relId}"`);
      }
    }

    // Active topics should have examples and communicative uses
    if (topic.isActive) {
      if (topic.examples.length === 0) {
        errors.push(`Active topic "${topic.id}" has no examples`);
      }
      if (topic.communicativeUses.length === 0) {
        errors.push(`Active topic "${topic.id}" has no communicativeUses`);
      }
    }
  }

  // Cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycleErrors: string[] = [];

  function detectCycle(id: string, path: string[]): boolean {
    if (inStack.has(id)) {
      cycleErrors.push(`Circular dependency: ${[...path, id].join(' → ')}`);
      return true;
    }
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const topic = topicMap.get(id);
    if (topic) {
      for (const prereqId of topic.prerequisites) {
        detectCycle(prereqId, [...path, id]);
      }
    }
    inStack.delete(id);
    return false;
  }

  for (const topic of topics) {
    detectCycle(topic.id, []);
  }
  errors.push(...cycleErrors);

  return { valid: errors.length === 0, errors, warnings };
}
