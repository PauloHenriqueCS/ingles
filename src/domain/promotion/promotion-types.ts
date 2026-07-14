import type { CEFRLevel } from '../curriculum/cefr';
import type { LearningSkill } from '../learner/learner-skill-types';

// Only A1..C1 supported (no C2 promotion)
export type PromotableLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
export const PROMOTABLE_LEVELS: readonly PromotableLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

export type PromotionDecision =
  | 'promote'
  | 'keep_level'
  | 'insufficient_data'
  | 'configuration_error'
  | 'maximum_supported_level';

export type PromotionRequirementStatus =
  | 'passed'
  | 'failed'
  | 'pending'
  | 'insufficient_data'
  | 'configuration_error';

export type PromotionTrigger =
  | 'mission_completed'
  | 'checkpoint_completed'
  | 'evidence_processed'
  | 'topic_mastered'
  | 'session_ended'
  | 'admin_recalculate'
  | 'job'
  | 'retry';

export type PromotionRegressionSignal =
  | 'stable'
  | 'attention_required'
  | 'possible_regression'
  | 'reassessment_required';

export interface RequirementResult {
  key: string;
  label: string;
  status: PromotionRequirementStatus;
  currentValue: number | string | null;
  requiredValue: number | string | null;
  confidence?: number;
  pendingItems?: string[];
  explanation: string;
}

export interface SkillPromotionEvaluation {
  userId: string;
  skill: LearningSkill;
  currentLevel: CEFRLevel;
  targetLevel: CEFRLevel | null;
  decision: PromotionDecision;
  eligibleForPromotion: boolean;
  promotionConfidence: number;
  progressPercent: number;
  regressionSignal: PromotionRegressionSignal;
  evaluatedAt: string;
  engineVersion: string;
  curriculumVersion: number;
  requirements: RequirementResult[];
  blockingReasons: string[];
  summary: string;
  evidenceSnapshot: Record<string, unknown>;
}

// Evidence bundle passed to the pure engine (collected from DB separately)
export interface MissionEvidence {
  validCount: number;
  missionIds: string[];
  distinctDates: number;  // for consistency check
  latestMissionAt: string | null;
}

export interface TopicMasteryInfo {
  topicId: string;
  isEssential: boolean;  // expectedMasteryLevel === currentLevel
  mastered: boolean;     // state in ('mastered', 'maintenance')
  prerequisites: string[];
  prerequisitesMastered: boolean;
  successfulUses: number;
  totalOpportunities: number;
  confidence: number;
  distinctContextCount: number;
  lastPracticedAt: string | null;
}

export interface CheckpointSummary {
  completedCount: number;
  passedCount: number;
}

export interface ConsistencyInfo {
  distinctDates: number;      // how many distinct calendar days have evidence
  singleSessionOnly: boolean; // all evidence from one session
  recentMissionsCount: number;
  hasDecline: boolean;        // persistent performance decline detected
}

export interface PromotionEvidenceBundle {
  userId: string;
  skill: LearningSkill;
  currentLevel: CEFRLevel;
  missions: MissionEvidence;
  topicMastery: TopicMasteryInfo[];  // for writing; empty for pronunciation/conversation
  checkpoints: CheckpointSummary;
  consistency: ConsistencyInfo;
  // Skill-specific extras
  pronunciationAccuracy?: number | null;  // 0-1, null = no data
  conversationSessionCount?: number;      // valid sessions
  conversationDistinctContexts?: number;
}
