import type { SupabaseClient } from '@supabase/supabase-js';

export interface LeaseResult {
  acquired: boolean;
  leaseKey: string;
}

// Lease duration: 2 minutes (used by the caller to set evaluation timeout)

/**
 * Attempt to acquire an evaluation lease by inserting a 'pending' row
 * into writing_rewrite_evaluations.
 * If a unique constraint conflict (23505) occurs, another process holds the lease.
 */
export async function acquireEvaluationLease(
  supabase: SupabaseClient,
  rewriteSubmissionId: string,
  evaluationVersion: number,
  requestId: string,
): Promise<LeaseResult> {
  const { data, error } = await supabase
    .from('writing_rewrite_evaluations')
    .insert({
      user_id: requestId, // placeholder — will be updated properly by orchestrator
      original_submission_id: rewriteSubmissionId, // temporary — overwritten on persist
      rewrite_submission_id: rewriteSubmissionId,
      review_id: rewriteSubmissionId, // temporary — overwritten on persist
      evaluation_version: evaluationVersion,
      status: 'pending',
      correction_resolution_score: 0,
      new_error_avoidance_score: 0,
      meaning_preservation_score: 0,
      clarity_improvement_score: 0,
      cohesion_improvement_score: 0,
      independence_score: 0,
      overall_improvement_score: 0,
      independence_assessment: 'uncertain',
      summary_pt_br: '',
      new_issues_json: [],
      scoring_version: 'v1',
      schema_version: 'v1',
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Unique constraint: another process already holds the lease
      return { acquired: false, leaseKey: '' };
    }
    throw new Error(`Failed to acquire evaluation lease: ${error.message}`);
  }

  return { acquired: true, leaseKey: (data as { id: string }).id };
}

/**
 * Release the lease on unexpected failure by marking the evaluation as 'failed'
 * if it is still 'pending'.
 */
export async function releaseEvaluationLease(
  supabase: SupabaseClient,
  leaseKey: string,
): Promise<void> {
  const { error } = await supabase
    .from('writing_rewrite_evaluations')
    .update({ status: 'failed' })
    .eq('id', leaseKey)
    .eq('status', 'pending');

  if (error) {
    // Best-effort cleanup — log but don't throw
    console.error(
      JSON.stringify({
        event: 'rewrite_lease_release_failed',
        leaseKey,
        errorMessage: error.message,
        ts: new Date().toISOString(),
      }),
    );
  }
}
