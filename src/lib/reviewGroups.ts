import { supabase } from './supabase';
import { MainMistake } from '../types';

interface CreateGroupParams {
  reviewId: string;
  mistakes: MainMistake[];
  entryDate?: string;
  theme?: string;
}

export async function createReviewGroupFromReview({
  reviewId,
  mistakes,
  entryDate,
  theme,
}: CreateGroupParams): Promise<void> {
  if (mistakes.length === 0) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Não autenticado');

  const nextReviewAt = new Date();
  nextReviewAt.setDate(nextReviewAt.getDate() + 2);

  const { data: group, error: groupError } = await supabase
    .from('review_groups')
    .insert({
      user_id: user.id,
      source_review_id: reviewId,
      source_entry_date: entryDate ?? null,
      original_theme: theme ?? null,
      status: 'scheduled',
      review_level: 0,
      next_review_at: nextReviewAt.toISOString(),
    })
    .select('id')
    .single();

  if (groupError) {
    // Unique constraint violation = group already exists for this review
    if (groupError.code === '23505') return;
    throw new Error(groupError.message);
  }

  const items = mistakes.map((m) => ({
    review_group_id: group.id,
    original_value: m.original,
    corrected_value: m.correct,
    explanation: m.explanation || null,
    original_sentence: null,
  }));

  const { error: itemsError } = await supabase
    .from('review_group_items')
    .insert(items);

  if (itemsError) throw new Error(itemsError.message);
}
