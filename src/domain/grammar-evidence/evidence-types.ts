export type GrammarEvidenceSourceType =
  | 'original_review'
  | 'rewrite_evaluation'
  | 'diagnostic'
  | 'calibration'
  | 'checkpoint'
  | 'manual_admin';

export type GrammarEvidenceType =
  | 'opportunity'
  | 'successful_use'
  | 'error'
  | 'partial_success'
  | 'attempt_above_level'
  | 'no_opportunity'
  | 'retention_success'
  | 'retention_failure';

export type GrammarProductionMode =
  | 'independent'
  | 'guided'
  | 'assisted'
  | 'system_generated'
  | 'unknown';

export type GrammarEvidenceOutcome =
  | 'success'
  | 'partial'
  | 'failure'
  | 'neutral';

export type GrammarTopicRole =
  | 'primary'
  | 'secondary'
  | 'review'
  | 'exposure_only'
  | 'unplanned'
  | 'locked';

export type GrammarMasteryReasonCode =
  | 'TOPIC_INTRODUCED'
  | 'FIRST_VALID_OPPORTUNITY'
  | 'GUIDED_PRACTICE_STARTED'
  | 'SUFFICIENT_PRACTICE_EVIDENCE'
  | 'SUFFICIENT_CONSOLIDATION_EVIDENCE'
  | 'MASTERY_CRITERIA_MET'
  | 'MAINTENANCE_DUE'
  | 'MAINTENANCE_SUCCESS'
  | 'REPEATED_RECENT_FAILURES'
  | 'RETENTION_FAILURE'
  | 'PREREQUISITE_NOT_READY'
  | 'INSUFFICIENT_CONTEXT_DIVERSITY'
  | 'INSUFFICIENT_INDEPENDENT_USE'
  | 'ADMIN_OVERRIDE'
  | 'LEGACY_MIGRATION';

// Canonical grammar evidence entity (what gets persisted in learner_grammar_evidence)
export interface LearnerGrammarEvidence {
  id: string;
  userId: string;
  grammarTopicId: string;
  catalogVersion: number;
  skill: string;
  sourceType: GrammarEvidenceSourceType;
  sourceId: string;
  missionId?: string;
  submissionId?: string;
  reviewId?: string;
  rewriteSubmissionId?: string;
  correctionId?: string;
  evidenceType: GrammarEvidenceType;
  productionMode: GrammarProductionMode;
  outcome: GrammarEvidenceOutcome;
  opportunityWeight: number;  // 0–1 quality of the opportunity
  evidenceWeight: number;     // positive or negative weight of this evidence
  confidence: number;         // 0–1 confidence in this evidence
  plannedTopic: boolean;      // Was this topic planned in the mission?
  topicRole: GrammarTopicRole;
  contextKey: string;
  contextFamily: string;
  supportLevel: string;       // 'none' | 'low' | 'medium' | 'high'
  helpUsed: boolean;
  occurredAt: string;
  processedAt: string;
  idempotencyKey: string;
  rulesVersion: string;
  metadataJson?: Record<string, unknown>;
  createdAt: string;
}
