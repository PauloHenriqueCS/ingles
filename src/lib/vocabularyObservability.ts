/**
 * SERVER-ONLY: structured event logging for vocabulary evidence pipeline.
 * Never logs text content (no submission text, corrections, or personal data).
 */

export type VocabularyEventType =
  | 'vocabulary_candidate_processing_started'
  | 'vocabulary_item_resolved'
  | 'vocabulary_item_created'
  | 'vocabulary_form_resolved'
  | 'vocabulary_synonym_accepted'
  | 'vocabulary_evidence_created'
  | 'vocabulary_evidence_duplicate_ignored'
  | 'vocabulary_schedule_updated'
  | 'vocabulary_item_mastered'
  | 'vocabulary_lapse_detected'
  | 'vocabulary_item_suspended'
  | 'vocabulary_rebuild_started'
  | 'vocabulary_rebuild_completed'
  | 'vocabulary_processing_failed';

export interface VocabularyEventPayload {
  event: VocabularyEventType;
  userId?: string;
  itemId?: string;
  sourceType?: string;
  sourceId?: string;
  evidenceType?: string;
  productionMode?: string;
  previousState?: string;
  newState?: string;
  nextReviewAt?: string;
  schedulingVersion?: string;
  latencyMs?: number;
  errorMessage?: string;
  // NO full text content
}

export function logVocabularyEvent(payload: VocabularyEventPayload): void {
  console.log(JSON.stringify({ ...payload, ts: new Date().toISOString() }));
}
