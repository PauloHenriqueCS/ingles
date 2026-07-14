import { CEFRLevel } from './cefr';

export type GrammarTopicCategory =
  | 'verb_tense'
  | 'verb_form'
  | 'modal'
  | 'noun'
  | 'pronoun'
  | 'article'
  | 'determiner'
  | 'adjective'
  | 'adverb'
  | 'preposition'
  | 'conjunction'
  | 'question'
  | 'negation'
  | 'comparison'
  | 'conditional'
  | 'passive'
  | 'reported_speech'
  | 'relative_clause'
  | 'discourse'
  | 'word_order'
  | 'other';

export type GrammarLearningStage =
  | 'exposure'
  | 'guided_practice'
  | 'independent_production'
  | 'mastery';

export interface GrammarTopic {
  readonly id: string;
  readonly version: number;
  readonly slug: string;
  readonly title: {
    readonly en: string;
    readonly ptBR: string;
  };
  readonly category: GrammarTopicCategory;

  readonly minimumExposureLevel: CEFRLevel;
  readonly minimumGuidedPracticeLevel: CEFRLevel;
  readonly minimumIndependentProductionLevel: CEFRLevel;
  readonly expectedMasteryLevel: CEFRLevel;

  readonly prerequisites: readonly string[];
  readonly relatedTopics: readonly string[];

  readonly communicativeUses: readonly string[];
  readonly structures: {
    readonly affirmative?: readonly string[];
    readonly negative?: readonly string[];
    readonly interrogative?: readonly string[];
    readonly other?: readonly string[];
  };

  readonly examples: ReadonlyArray<{
    readonly en: string;
    readonly ptBR: string;
    readonly stage?: GrammarLearningStage;
  }>;

  readonly commonErrors: ReadonlyArray<{
    readonly incorrect: string;
    readonly correct: string;
    readonly explanationPtBR: string;
  }>;

  readonly generationRules: {
    readonly allowedContexts?: readonly string[];
    readonly avoidContexts?: readonly string[];
    readonly forbiddenCombinations?: readonly string[];
    readonly notesForGenerator?: readonly string[];
  };

  readonly assessment: {
    readonly opportunityTypes: readonly string[];
    readonly evidenceRequiredForMastery?: number;
    readonly requiredContextsForMastery?: number;
  };

  readonly tags: readonly string[];
  readonly isActive: boolean;
}
