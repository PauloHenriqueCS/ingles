import type { SupabaseClient } from '@supabase/supabase-js';
import type { WritingRewriteAttempt, SupportUsageSnapshot } from '../domain/writing-rewrite/rewrite-types';
import type { RewriteStatus } from '../domain/writing-rewrite/rewrite-status';

export interface CreateRewriteAttemptInput {
  userId: string;
  missionId?: string;
  reviewId: string;
  rewriteSequence: number;
  rewriteText?: string;
  originalTextSnapshot: string;
  correctedTextHash: string;
  reviewVersion: number;
  supportUsageSnapshot?: SupportUsageSnapshot;
}

function rowToAttempt(row: Record<string, unknown>): WritingRewriteAttempt {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    missionId: row.mission_id as string | undefined,
    reviewId: row.review_id as string,
    rewriteSequence: row.rewrite_sequence as number,
    status: row.status as RewriteStatus,
    authorType: row.author_type as WritingRewriteAttempt['authorType'],
    submissionType: row.submission_type as WritingRewriteAttempt['submissionType'],
    rewriteText: row.rewrite_text as string | null,
    originalTextSnapshot: row.original_text_snapshot as string,
    correctedTextHash: row.corrected_text_hash as string,
    reviewVersion: row.review_version as number,
    supportUsageSnapshot: row.support_usage_snapshot as SupportUsageSnapshot | undefined,
    createdAt: row.created_at as string,
    submittedAt: row.submitted_at as string | undefined,
  };
}

export async function createRewriteAttempt(
  supabase: SupabaseClient,
  input: CreateRewriteAttemptInput,
): Promise<WritingRewriteAttempt> {
  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .insert({
      user_id: input.userId,
      mission_id: input.missionId ?? null,
      review_id: input.reviewId,
      rewrite_sequence: input.rewriteSequence,
      status: 'draft',
      author_type: 'learner',
      submission_type: 'rewrite_v2',
      rewrite_text: input.rewriteText ?? null,
      original_text_snapshot: input.originalTextSnapshot,
      corrected_text_hash: input.correctedTextHash,
      review_version: input.reviewVersion,
      support_usage_snapshot: input.supportUsageSnapshot ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create rewrite attempt: ${error.message}`);
  return rowToAttempt(data as Record<string, unknown>);
}

export async function getRewriteAttemptById(
  supabase: SupabaseClient,
  attemptId: string,
): Promise<WritingRewriteAttempt | null> {
  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .select('*')
    .eq('id', attemptId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to get rewrite attempt: ${error.message}`);
  }
  return rowToAttempt(data as Record<string, unknown>);
}

/** Returns all rewrite attempts for a given review, ordered by rewrite_sequence ASC. */
export async function getRewriteAttemptsForReview(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
): Promise<WritingRewriteAttempt[]> {
  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .select('*')
    .eq('review_id', reviewId)
    .eq('user_id', userId)
    .order('rewrite_sequence', { ascending: true });

  if (error) throw new Error(`Failed to get rewrite attempts for review: ${error.message}`);
  return (data as Record<string, unknown>[]).map(rowToAttempt);
}

export async function getLatestRewriteAttempt(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
): Promise<WritingRewriteAttempt | null> {
  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .select('*')
    .eq('review_id', reviewId)
    .eq('user_id', userId)
    .order('rewrite_sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get latest rewrite attempt: ${error.message}`);
  if (!data) return null;
  return rowToAttempt(data as Record<string, unknown>);
}

export async function updateRewriteAttemptStatus(
  supabase: SupabaseClient,
  attemptId: string,
  status: RewriteStatus,
  submittedAt?: string,
): Promise<WritingRewriteAttempt> {
  const update: Record<string, unknown> = { status };
  if (submittedAt !== undefined) update.submitted_at = submittedAt;

  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .update(update)
    .eq('id', attemptId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update rewrite attempt status: ${error.message}`);
  return rowToAttempt(data as Record<string, unknown>);
}

/** Only allowed in 'draft' status — throws if not draft. */
export async function updateRewriteText(
  supabase: SupabaseClient,
  attemptId: string,
  rewriteText: string,
): Promise<WritingRewriteAttempt> {
  // Verify current status before update
  const current = await getRewriteAttemptById(supabase, attemptId);
  if (!current) throw new Error(`Rewrite attempt not found: ${attemptId}`);
  if (current.status !== 'draft') {
    throw new Error(
      `Cannot update rewrite text: attempt is in '${current.status}' status (must be 'draft')`,
    );
  }

  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .update({ rewrite_text: rewriteText })
    .eq('id', attemptId)
    .eq('status', 'draft') // double-check via DB filter
    .select()
    .single();

  if (error) throw new Error(`Failed to update rewrite text: ${error.message}`);
  return rowToAttempt(data as Record<string, unknown>);
}

/** Returns the next sequence number (MAX + 1, or 1 if none). */
export async function getNextRewriteSequence(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('writing_rewrite_attempts')
    .select('rewrite_sequence')
    .eq('review_id', reviewId)
    .eq('user_id', userId)
    .order('rewrite_sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to get next rewrite sequence: ${error.message}`);
  if (!data) return 1;
  return ((data as Record<string, unknown>).rewrite_sequence as number) + 1;
}
