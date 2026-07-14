/**
 * SERVER-ONLY: write to learner_vocabulary_mastery_history.
 * Only called for meaningful state transitions and lapses.
 * Never import in React components or client-side bundles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VocabularyLearningState } from '../domain/vocabulary/vocabulary-types';
import type { VocabularyMasteryReasonCode } from '../domain/vocabulary/vocabulary-reason-codes';

export interface RecordVocabularyHistoryInput {
  userId: string;
  vocabularyItemId: string;
  previousState: VocabularyLearningState;
  newState: VocabularyLearningState;
  previousNextReviewAt: string | null;
  newNextReviewAt: string | null;
  previousStability: number;
  newStability: number;
  reasonCode: VocabularyMasteryReasonCode;
  evidenceIds: string[];
  schedulingVersion: string;
}

export async function recordVocabularyHistory(
  supabase: SupabaseClient,
  input: RecordVocabularyHistoryInput,
): Promise<void> {
  const payload = {
    user_id: input.userId,
    vocabulary_item_id: input.vocabularyItemId,
    previous_state: input.previousState,
    new_state: input.newState,
    previous_next_review_at: input.previousNextReviewAt ?? null,
    new_next_review_at: input.newNextReviewAt ?? null,
    previous_stability: input.previousStability,
    new_stability: input.newStability,
    reason_code: input.reasonCode,
    evidence_ids: input.evidenceIds,
    scheduling_version: input.schedulingVersion,
  };

  const { error } = await supabase
    .from('learner_vocabulary_mastery_history')
    .insert(payload);

  if (error) throw new Error(`recordVocabularyHistory: ${error.message}`);
}
