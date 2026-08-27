import { supabase } from './supabase';
import { RewriteComparisonResult } from '../types';

// english_reviews rows (the "consumo de Revisão" the plan limit gates) are
// now inserted server-side by api/review-text.ts, atomically with the
// reserve/complete ledger (writing_review_reservations) — never from the
// client. See that file's handler for why: a client-side insert decoupled
// from the AI call let the daily review limit be bypassed or miscounted.

export async function updateReviewV2(
  reviewId: string,
  v2Text: string,
  v2Comparison: RewriteComparisonResult,
): Promise<void> {
  const { error } = await supabase
    .from('english_reviews')
    .update({
      version_2_text: v2Text,
      version_2_comparison: v2Comparison,
      version_2_improvement_score: v2Comparison.improvementScore,
    })
    .eq('id', reviewId);
  if (error) throw new Error(error.message);
}

export async function updateV2FinalText(
  reviewId: string,
  v2FinalText: string,
): Promise<void> {
  const { error } = await supabase
    .from('english_reviews')
    .update({ version_2_final_text: v2FinalText })
    .eq('id', reviewId);
  if (error) throw new Error(error.message);
}

/**
 * Records that the learner explicitly concluded the writing activity from the
 * Feedback step (the V1-only path). This is a presentation milestone only — the
 * calendar/streak/curriculum credit already counts the writing at 'corrigido',
 * so this never affects any commercial accounting. Idempotent: the caller only
 * needs it set once. Owner-update path, same as updateV2FinalText.
 */
export async function markReviewConcluded(reviewId: string): Promise<void> {
  const { error } = await supabase
    .from('english_reviews')
    .update({ concluded_at: new Date().toISOString() })
    .eq('id', reviewId)
    .is('concluded_at', null);
  if (error) throw new Error(error.message);
}
