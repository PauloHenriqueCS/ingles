import { GrammarTopic } from './grammar-types';
import { getGrammarTopicById } from './grammar-indexes';

// Maps normalized legacy strings → canonical grammar topic ID (or null for ambiguous/no canonical match)
const LEGACY_ALIAS_MAP: Record<string, string | null> = {
  // From grammarContent.ts DB keys (lowercase)
  'present simple': 'grammar.present_simple',
  'present continuous': 'grammar.present_continuous',
  'simple past': 'grammar.past_simple',
  'past continuous': 'grammar.past_continuous',
  'present perfect': 'grammar.present_perfect.intro',
  'present perfect continuous': 'grammar.present_perfect_continuous.intro',
  'past perfect': 'grammar.past_perfect.intro',
  'future simple': 'grammar.future.will',
  'future going to': 'grammar.future.going_to',
  'first conditional': 'grammar.conditionals.first',
  'second conditional': 'grammar.conditionals.second',
  'third conditional': 'grammar.conditionals.third',
  'modal verbs': 'grammar.modals.deduction',  // closest general modal topic
  'passive voice': 'grammar.passive.present_simple',
  'reported speech': 'grammar.reported_speech.basic',

  // From grammarContent.ts ALIASES (already normalized lowercase)
  'simple present': 'grammar.present_simple',
  'present tense': 'grammar.present_simple',
  'present progressive': 'grammar.present_continuous',
  'present participle': 'grammar.present_continuous',
  'past simple': 'grammar.past_simple',
  'simple past tense': 'grammar.past_simple',
  'past tense': 'grammar.past_simple',
  'past progressive': 'grammar.past_continuous',
  'present perfect tense': 'grammar.present_perfect.intro',
  'present perfect simple': 'grammar.present_perfect.intro',
  'past perfect tense': 'grammar.past_perfect.intro',
  'pluperfect': 'grammar.past_perfect.intro',
  'will future': 'grammar.future.will',
  'simple future': 'grammar.future.will',
  'future with will': 'grammar.future.will',
  'be going to': 'grammar.future.going_to',
  'going to': 'grammar.future.going_to',
  'future with going to': 'grammar.future.going_to',
  'conditional type 1': 'grammar.conditionals.first',
  'type 1 conditional': 'grammar.conditionals.first',
  'real conditional': 'grammar.conditionals.first',
  'conditional type 2': 'grammar.conditionals.second',
  'type 2 conditional': 'grammar.conditionals.second',
  'unreal conditional': 'grammar.conditionals.second',
  'conditional type 3': 'grammar.conditionals.third',
  'type 3 conditional': 'grammar.conditionals.third',
  'mixed conditional': 'grammar.conditionals.mixed_intro',
  'modais': 'grammar.modals.deduction',
  'modals': 'grammar.modals.deduction',
  'modal auxiliaries': 'grammar.modals.deduction',
  'can / could': 'grammar.can',
  'should / would': 'grammar.modals.should',
  'passive': 'grammar.passive.present_simple',
  'voz passiva': 'grammar.passive.present_simple',
  'indirect speech': 'grammar.reported_speech.basic',
  'discurso indireto': 'grammar.reported_speech.basic',
  'direct and indirect speech': 'grammar.reported_speech.basic',

  // From calendar2026.ts monthly tenses
  'future: will / going to': 'grammar.future.will',
  'conditionals (1st & 2nd)': 'grammar.conditionals.first',
  'revisão geral': null, // general review — no single canonical topic

  // Common variations
  'can': 'grammar.can',
  'can/cannot': 'grammar.can',
  'to be': 'grammar.verb_to_be.present',
  'verb to be': 'grammar.verb_to_be.present',
  'articles': 'grammar.articles',
  'comparatives': 'grammar.adjectives.comparative',
  'superlatives': 'grammar.adjectives.superlative',
  'used to': 'grammar.used_to',
  'wish': 'grammar.wish_if_only',
  'if only': 'grammar.wish_if_only',
  'question tags': 'grammar.question_tags',
  'phrasal verbs': 'grammar.phrasal_verbs.common',
  'gerunds': 'grammar.gerunds.basic',
  'gerunds and infinitives': 'grammar.gerund_infinitive.choice',
  'relative clauses': 'grammar.relative_clauses.basic',
};

// Track unknown aliases to support detection in dev/test
const _unknownAliases = new Set<string>();

export function getUnknownAliasLog(): readonly string[] {
  return [..._unknownAliases];
}

export function resolveLegacyGrammarTopic(input: string): GrammarTopic | null {
  if (!input || typeof input !== 'string') return null;

  const normalized = input.toLowerCase().trim().replace(/\s+/g, ' ');

  const targetId = LEGACY_ALIAS_MAP[normalized];

  // Explicitly mapped to null (ambiguous / no canonical match)
  if (targetId === null) return null;

  if (targetId !== undefined) {
    return getGrammarTopicById(targetId);
  }

  // Record unknown alias
  _unknownAliases.add(normalized);
  return null;
}

export function isKnownLegacyAlias(input: string): boolean {
  const normalized = input.toLowerCase().trim().replace(/\s+/g, ' ');
  return normalized in LEGACY_ALIAS_MAP;
}

export const ALL_LEGACY_ALIASES: readonly string[] = Object.keys(LEGACY_ALIAS_MAP);
