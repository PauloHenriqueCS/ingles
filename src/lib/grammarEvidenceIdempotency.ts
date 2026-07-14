/**
 * SERVER-ONLY: idempotency key builders for grammar evidence pipeline.
 */

import type { GrammarEvidenceSourceType, GrammarEvidenceType } from '../domain/grammar-evidence/evidence-types';

export function buildEvidenceIdempotencyKey(params: {
  sourceType: GrammarEvidenceSourceType;
  sourceId: string;
  grammarTopicId: string;
  evidenceType: GrammarEvidenceType;
  contextKey: string;
}): string {
  return `${params.sourceType}:${params.sourceId}:${params.grammarTopicId}:${params.evidenceType}:${params.contextKey}`;
}
