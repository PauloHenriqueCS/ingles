import type { LearnerVocabularyMastery, PlannedVocabularyRole } from './vocabulary-types';

export interface VocabularyReviewLimits {
  maxItems: number;
  maxRequired: number;
}

// Level-specific limits
export const VOCABULARY_REVIEW_LIMITS: Record<string, VocabularyReviewLimits> = {
  A1: { maxItems: 3, maxRequired: 1 },
  A2: { maxItems: 4, maxRequired: 1 },
  B1: { maxItems: 5, maxRequired: 2 },
  B2: { maxItems: 6, maxRequired: 2 },
  C1: { maxItems: 6, maxRequired: 2 },
  C2: { maxItems: 6, maxRequired: 3 },
};

export interface DueVocabularyItem {
  mastery: LearnerVocabularyMastery;
  canonicalValue: string;
  kind: string;
  plannedRole?: PlannedVocabularyRole;
  daysOverdue: number;
}

export interface VocabularyRankingInput {
  dueItems: DueVocabularyItem[];
  contextFamily?: string;
  recentlyUsedItemIds: string[];  // items used in last 3 missions
  level: string;
  nowIso: string;
}

export function rankVocabularyReviewItems(input: VocabularyRankingInput): DueVocabularyItem[] {
  const { dueItems, recentlyUsedItemIds, level } = input;
  const recentSet = new Set(recentlyUsedItemIds);
  const limits = getLimitsForLevel(level);

  // Filter out suspended items (must not include)
  const eligible = dueItems.filter(item => item.mastery.state !== 'suspended');

  // Score each item
  const scored = eligible.map(item => {
    const { mastery, daysOverdue } = item;
    let score = daysOverdue * 10;
    score += mastery.lapseCount * 20;
    score += mastery.errorCount > 2 ? 15 : 0;
    score += mastery.state === 'reviewing' ? 5 : 0;
    score -= recentSet.has(mastery.vocabularyItemId) ? 30 : 0;
    score += mastery.difficulty > 0.7 ? 10 : 0;
    return { item, score };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Apply level limits
  const result = scored.slice(0, limits.maxItems).map(s => s.item);
  return result;
}

export function getLimitsForLevel(level: string): VocabularyReviewLimits {
  return VOCABULARY_REVIEW_LIMITS[level] ?? { maxItems: 5, maxRequired: 2 };
}
