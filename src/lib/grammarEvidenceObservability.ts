/**
 * SERVER-ONLY: structured event logging for grammar evidence pipeline.
 * Never logs text content (no submission text, corrections, or personal data).
 */

export type GrammarEvidenceEventType =
  | 'grammar_evidence_processing_started'
  | 'grammar_evidence_candidate_loaded'
  | 'grammar_opportunity_evaluated'
  | 'grammar_production_mode_resolved'
  | 'grammar_evidence_created'
  | 'grammar_evidence_duplicate_ignored'
  | 'grammar_mastery_aggregate_updated'
  | 'grammar_mastery_transitioned'
  | 'grammar_mastery_transition_blocked'
  | 'grammar_mastery_rebuild_started'
  | 'grammar_mastery_rebuild_completed'
  | 'grammar_evidence_processing_failed';

export interface GrammarEvidenceEventPayload {
  event: GrammarEvidenceEventType;
  userId?: string;    // hash or mask if needed
  topicId?: string;
  sourceType?: string;
  sourceId?: string;
  evidenceType?: string;
  productionMode?: string;
  evidenceWeight?: number;
  previousState?: string;
  newState?: string;
  rulesVersion?: string;
  latencyMs?: number;
  errorMessage?: string;
  // NO text content in logs
}

export function logGrammarEvidenceEvent(payload: GrammarEvidenceEventPayload): void {
  console.log(JSON.stringify({ ...payload, ts: new Date().toISOString() }));
}
