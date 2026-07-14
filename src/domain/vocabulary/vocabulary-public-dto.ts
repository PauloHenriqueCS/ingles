import type { VocabularyItemKind, VocabularyLearningState, LearnerVocabularyMastery } from './vocabulary-types';

export interface PublicVocabularyMasteryDTO {
  vocabularyItemId: string;
  value: string;
  translationPtBR: string | null;
  kind: VocabularyItemKind;
  state: VocabularyLearningState;
  progress: {
    exposures: number;
    successfulUses: number;
    independentUses: number;
    distinctContexts: number;
  };
  lastPracticedAt: string | null;
  nextReviewAt: string | null;
}

export function buildPublicVocabularyMasteryDTO(
  mastery: LearnerVocabularyMastery,
  itemValue: string,
  translationPtBR: string | null,
  kind: VocabularyItemKind,
): PublicVocabularyMasteryDTO {
  return {
    vocabularyItemId: mastery.vocabularyItemId,
    value: itemValue,
    translationPtBR,
    kind,
    state: mastery.state,
    progress: {
      exposures: mastery.totalExposures,
      successfulUses: mastery.successfulUses,
      independentUses: mastery.independentUses,
      distinctContexts: mastery.distinctContextCount,
    },
    lastPracticedAt: mastery.lastPracticedAt,
    // suspended items do not expose nextReviewAt
    nextReviewAt: mastery.state === 'suspended' ? null : mastery.nextReviewAt,
  };
  // NEVER expose: stability, difficulty, weight, evidences, lapseCount internals, copy signals
}

export function buildPublicVocabularyListDTO(
  items: Array<{
    mastery: LearnerVocabularyMastery;
    itemValue: string;
    translationPtBR: string | null;
    kind: VocabularyItemKind;
  }>,
): PublicVocabularyMasteryDTO[] {
  // Filter out suspended items from public view
  const visible = items.filter(i => i.mastery.state !== 'suspended');

  // Build DTOs
  const dtos = visible.map(i =>
    buildPublicVocabularyMasteryDTO(i.mastery, i.itemValue, i.translationPtBR, i.kind),
  );

  // Sort: mastered first, then by nextReviewAt ASC (null last)
  dtos.sort((a, b) => {
    const aMastered = a.state === 'mastered' ? 0 : 1;
    const bMastered = b.state === 'mastered' ? 0 : 1;
    if (aMastered !== bMastered) return aMastered - bMastered;

    // Sort by nextReviewAt ASC (null goes last)
    if (a.nextReviewAt === null && b.nextReviewAt === null) return 0;
    if (a.nextReviewAt === null) return 1;
    if (b.nextReviewAt === null) return -1;
    return a.nextReviewAt.localeCompare(b.nextReviewAt);
  });

  return dtos;
}
