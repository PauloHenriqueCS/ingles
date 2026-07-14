/**
 * SERVER-ONLY: idempotency key generation for vocabulary evidence.
 * Never import in React components or client-side bundles.
 */

import type { VocabularyEvidenceSourceType, VocabularyEvidenceType } from '../domain/vocabulary/vocabulary-types';

export function buildVocabularyEvidenceIdempotencyKey(params: {
  sourceType: VocabularyEvidenceSourceType;
  sourceId: string;
  vocabularyItemId: string;
  evidenceType: VocabularyEvidenceType;
  occurrenceKey: string;   // contextKey or position in source
}): string {
  return `${params.sourceType}:${params.sourceId}:${params.vocabularyItemId}:${params.evidenceType}:${params.occurrenceKey}`;
}
