import type { CEFRLevel } from '../../curriculum/cefr';
import type { GrammarMasteryState } from '../../learner/grammar-mastery-types';
import type { SkillAssessmentStatus } from '../../learner/learner-skill-types';

export type { CEFRLevel, GrammarMasteryState, SkillAssessmentStatus };

export type MissionDifficulty = 'easy' | 'medium' | 'hard';

export type MissionSupportLevel = 'minimal' | 'standard' | 'high';

export type PedagogicalPlanReason =
  | 'initial_safe_fallback'
  | 'diagnostic'
  | 'provisional_level'
  | 'ongoing_calibration'
  | 'normal_progression'
  | 'grammar_recovery'
  | 'vocabulary_recovery'
  | 'maintenance'
  | 'checkpoint'
  | 'manual_admin';

export type GrammarTopicRole =
  | 'primary'
  | 'secondary'
  | 'review'
  | 'exposure_only'
  | 'forbidden_requirement';

export type PlanningMode =
  | 'diagnostic'
  | 'calibration'
  | 'normal'
  | 'recovery'
  | 'maintenance'
  | 'checkpoint';

export interface PlannedGrammarTopic {
  topicId: string;
  role: GrammarTopicRole;
  learnerState: GrammarMasteryState;
  reasonCodes: string[];
  requiredOpportunityCount: number;
  explicitInstructionAllowed: boolean;
}

export interface PlannedVocabularyItem {
  vocabularyItemId?: string;
  normalizedValue: string;
  role: 'review' | 'support' | 'optional_stretch';
  required: boolean;
  reasonCodes: string[];
}

export interface MissionSupportConfiguration {
  showPortugueseIdeaField: boolean;
  allowSuggestedWords: boolean;
  allowSupportSentences: boolean;
  allowGrammarExplanation: boolean;
  autoRevealSupport: boolean;
  maximumSupportSentences: number;
}

export interface NoveltyBudget {
  maximumNewGrammarTopics: number;
  maximumNewVocabularyItems: number;
}

export interface RecoveryBudget {
  maximumGrammarReviewTopics: number;
  maximumVocabularyReviewItems: number;
}

export interface GenerationConstraints {
  requireEverydaySituation: boolean;
  requireConflictDecisionOrUnexpectedEvent: boolean;
  avoidGenericTopic: boolean;
  avoidExplicitGrammarExercise: boolean;
  forbiddenRequiredTopicIds: string[];
  forbiddenInstructions: string[];
  preferredContextFamilies: string[];
  avoidedContextFamilies: string[];
}

export interface ValidationRules {
  requiredTopicCoverage: string[];
  forbiddenRequiredTopicIds: string[];
  maximumEstimatedLevel: CEFRLevel;
  allowIncidentalAdvancedLanguage: boolean;
}

export interface MissionPedagogicalPlan {
  id: string;
  version: number;
  userId: string;
  skill: 'writing';

  catalogVersion: number;
  plannerVersion: string;

  learnerLevel: CEFRLevel | null;
  effectiveLevel: CEFRLevel;
  assessmentStatus: SkillAssessmentStatus;
  assessmentConfidence: number;

  mode: PlanningMode;
  difficulty: MissionDifficulty;
  reason: PedagogicalPlanReason;

  communicativeObjectiveId: string;
  communicativeFunctions: string[];

  grammarTopics: PlannedGrammarTopic[];
  vocabularyItems: PlannedVocabularyItem[];

  prerequisitesSatisfied: string[];
  prerequisitesMissing: string[];

  supportLevel: MissionSupportLevel;
  supportConfiguration: MissionSupportConfiguration;

  noveltyBudget: NoveltyBudget;
  recoveryBudget: RecoveryBudget;

  generationConstraints: GenerationConstraints;
  validationRules: ValidationRules;

  seed: string;
  createdAt: string;
  acceptedAt: string | null;
  supersededAt: string | null;
}

export interface LearnerGrammarSnapshot {
  topicId: string;
  state: GrammarMasteryState;
  confidence: number;
  maintenanceDueAt: string | null;
  lastPracticedAt: string | null;
  errorCount: number;
  distinctContextCount: number;
}

export interface RecentMissionPlan {
  communicativeObjectiveId: string;
  primaryTopicIds: string[];
  contextFamilies: string[];
  createdAt: string;
}

export interface LearnerPlanningSnapshot {
  userId: string;
  snapshotVersion: string;
  capturedAt: string;

  writingProfile: {
    level: CEFRLevel | null;
    status: SkillAssessmentStatus;
    confidence: number;
  } | null;

  grammarMastery: LearnerGrammarSnapshot[];
  recentPlans: RecentMissionPlan[];
  catalogVersion: number;
}
