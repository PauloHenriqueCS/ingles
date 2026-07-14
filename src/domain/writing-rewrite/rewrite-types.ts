import type { RewriteStatus } from './rewrite-status';

export type WritingAuthorType = 'learner' | 'system' | 'admin';
export type WritingSubmissionType = 'original' | 'rewrite_v2';
export type RewriteEvaluationStatus = 'pending' | 'completed' | 'failed';
export type RewriteIndependenceAssessment =
  | 'independent'
  | 'likely_independent'
  | 'uncertain'
  | 'likely_copied'
  | 'copied';
export type RewriteCorrectionOutcomeStatus =
  | 'corrected'
  | 'partially_corrected'
  | 'unchanged'
  | 'valid_alternative'
  | 'worsened'
  | 'not_applicable';
export type RewriteEvidenceType =
  | 'error_corrected_independently'
  | 'error_corrected_with_possible_copy'
  | 'valid_reformulation'
  | 'error_persisted'
  | 'new_error_introduced'
  | 'meaning_preserved'
  | 'meaning_changed'
  | 'cohesion_improved'
  | 'clarity_improved'
  | 'no_independent_evidence';
export type NewIssueCategory =
  | 'regression'
  | 'new_grammar_error'
  | 'new_vocabulary_error'
  | 'new_word_order_error'
  | 'new_clarity_problem'
  | 'meaning_changed'
  | 'task_deviation';

export interface SupportUsageSnapshot {
  correctedTextVisible: boolean;
  correctionsExpanded: boolean;
  supportSentencesAvailable: boolean;
  explanationsOpened: boolean;
  copyButtonUsed?: boolean;
  pasteDetected?: boolean;
  msFromReviewToSubmit?: number;
}

export interface WritingRewriteAttempt {
  id: string;
  userId: string;
  missionId?: string;
  reviewId: string;
  rewriteSequence: number;
  status: RewriteStatus;
  authorType: WritingAuthorType; // always 'learner'
  submissionType: WritingSubmissionType; // always 'rewrite_v2'
  rewriteText: string | null;
  originalTextSnapshot: string;
  correctedTextHash: string;
  reviewVersion: number;
  supportUsageSnapshot?: SupportUsageSnapshot;
  createdAt: string;
  submittedAt?: string;
}

export interface RewriteScoreComponents {
  correctionResolutionScore: number;  // 0–100
  newErrorAvoidanceScore: number;     // 0–100
  meaningPreservationScore: number;   // 0–100
  clarityImprovementScore: number;    // 0–100
  cohesionImprovementScore: number;   // 0–100
  independenceScore: number;          // 0–100
  overallImprovementScore: number;    // 0–100, calculated server-side
}

export interface RewriteCorrectionOutcome {
  correctionId: string;
  status: RewriteCorrectionOutcomeStatus;
  originalExcerpt: string;
  expectedCorrection: string;
  rewriteExcerpt?: string;
  explanationPtBR: string;
  confidence: number; // 0–1
  shouldAffectRewriteScore: boolean;
}

export interface NewIssue {
  category: NewIssueCategory;
  excerpt?: string;
  explanationPtBR: string;
}

export interface WritingRewriteEvaluation {
  id: string;
  userId: string;
  missionId?: string;
  originalSubmissionId: string; // english_reviews.id
  rewriteSubmissionId: string;  // writing_rewrite_attempts.id
  reviewId: string;
  evaluationVersion: number;
  status: RewriteEvaluationStatus;
  scores: RewriteScoreComponents;
  independenceAssessment: RewriteIndependenceAssessment;
  summaryPtBR: string;
  correctionOutcomes: RewriteCorrectionOutcome[];
  newIssues: NewIssue[];
  scoringVersion: string;
  schemaVersion: string;
  promptVersion?: string;
  modelProvider?: string;
  modelName?: string;
  createdAt: string;
  completedAt?: string;
}

export interface RewriteEvidenceCandidate {
  id: string;
  userId: string;
  rewriteSubmissionId: string;
  reviewId: string;
  correctionId?: string;
  grammarTopicId?: string;
  evidenceType: RewriteEvidenceType;
  independenceAssessment: RewriteIndependenceAssessment;
  confidence: number; // 0–1
  shouldAffectMastery: boolean;
  contextKey: string;
  createdAt: string;
}
