export type VocabularyItemKind =
  | 'word'
  | 'phrasal_verb'
  | 'collocation'
  | 'fixed_expression'
  | 'functional_phrase'
  | 'connector'
  | 'idiom';

export type VocabularyFormType =
  | 'lemma'
  | 'inflection'
  | 'plural'
  | 'conjugation'
  | 'contraction'
  | 'spelling_variant'
  | 'accepted_variant'
  | 'alias';

export type VocabularyRelationType =
  | 'synonym'
  | 'near_synonym'
  | 'antonym'
  | 'related'
  | 'preferred_alternative'
  | 'contextual_equivalent';

export type VocabularyLearningState =
  | 'new'
  | 'introduced'
  | 'learning'
  | 'reviewing'
  | 'mastered'
  | 'maintenance'
  | 'suspended';

export type PlannedVocabularyRole =
  | 'review'
  | 'support'
  | 'optional_stretch'
  | 'required';

export type VocabularyEvidenceSourceType =
  | 'original_review'
  | 'rewrite_evaluation'
  | 'diagnostic'
  | 'calibration'
  | 'checkpoint'
  | 'review_attempt'
  | 'manual_admin';

export type VocabularyEvidenceType =
  | 'exposure'
  | 'recognized'
  | 'recalled'
  | 'successful_use'
  | 'partial_use'
  | 'incorrect_use'
  | 'missed_required_item'
  | 'valid_synonym'
  | 'spelling_error'
  | 'meaning_error'
  | 'form_error'
  | 'copied_use'
  | 'retention_success'
  | 'retention_failure';

export type VocabularyProductionMode =
  | 'independent'
  | 'guided'
  | 'assisted'
  | 'system_generated'
  | 'unknown';

// Canonical vocabulary item (catalog entry)
export interface VocabularyItem {
  id: string;
  canonicalValue: string;
  normalizedValue: string;
  kind: VocabularyItemKind;
  language: string;
  translationPtBR: string | null;
  definitionEn: string | null;
  definitionPtBR: string | null;
  cefrMinimumLevel: string | null;
  partOfSpeech: string | null;
  lemma: string | null;
  isMultiword: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Per-form alias
export interface VocabularyItemForm {
  id: string;
  vocabularyItemId: string;
  formValue: string;
  normalizedForm: string;
  formType: VocabularyFormType;
  locale: string;
  isPrimary: boolean;
  createdAt: string;
}

// Synonym/relation
export interface VocabularyItemRelation {
  id: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: VocabularyRelationType;
  contextHint: string | null;
  createdAt: string;
}

// Learner's mastery state per item
export interface LearnerVocabularyMastery {
  id: string;
  userId: string;
  vocabularyItemId: string;
  state: VocabularyLearningState;
  totalExposures: number;
  totalOpportunities: number;
  successfulRecalls: number;
  successfulUses: number;
  independentUses: number;
  guidedUses: number;
  assistedUses: number;
  errorCount: number;
  lapseCount: number;
  distinctContextCount: number;
  stability: number;        // estimated days until 90% recall drops below threshold
  difficulty: number;       // 0.0–1.0 (0 = easy, 1 = very hard)
  confidence: number;       // 0.0–1.0
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastPracticedAt: string | null;
  lastSuccessAt: string | null;
  nextReviewAt: string | null;
  masteredAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Canonical evidence entity
export interface LearnerVocabularyEvidence {
  id: string;
  userId: string;
  vocabularyItemId: string;
  sourceType: VocabularyEvidenceSourceType;
  sourceId: string;
  missionId?: string;
  submissionId?: string;
  reviewId?: string;
  rewriteSubmissionId?: string;
  evidenceType: VocabularyEvidenceType;
  productionMode: VocabularyProductionMode;
  outcome: 'success' | 'partial' | 'failure' | 'neutral';
  plannedRole?: PlannedVocabularyRole;
  contextKey: string;
  contextFamily: string;
  confidence: number;
  weight: number;
  occurredAt: string;
  idempotencyKey: string;
  rulesVersion: string;
  metadataJson?: Record<string, unknown>;
  createdAt: string;
}
