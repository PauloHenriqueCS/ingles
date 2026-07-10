import { supabase } from './supabase';
import { PendingReviewGroup, ReviewGroup, ReviewGroupItem } from '../types';

function mapGroup(row: Record<string, any>): ReviewGroup {
  return {
    id: row.id,
    userId: row.user_id,
    sourceReviewId: row.source_review_id,
    sourceEntryDate: row.source_entry_date ?? null,
    originalTheme: row.original_theme ?? null,
    status: row.status,
    reviewLevel: row.review_level,
    nextReviewAt: row.next_review_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: Record<string, any>): ReviewGroupItem {
  return {
    id: row.id,
    reviewGroupId: row.review_group_id,
    originalValue: row.original_value,
    correctedValue: row.corrected_value,
    explanation: row.explanation ?? null,
    originalSentence: row.original_sentence ?? null,
    createdAt: row.created_at,
  };
}

export async function fetchPendingReviewGroup(): Promise<PendingReviewGroup | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('review_groups')
    .select('*, review_group_items(*)')
    .eq('user_id', user.id)
    .eq('status', 'scheduled')
    .lte('next_review_at', now)
    .order('next_review_at', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (error || !data) return null;

  const items: ReviewGroupItem[] = Array.isArray(data.review_group_items)
    ? data.review_group_items.map(mapItem)
    : [];

  if (items.length === 0) {
    console.warn('Review group has no items, skipping:', data.id);
    return null;
  }

  return { group: mapGroup(data), items };
}
