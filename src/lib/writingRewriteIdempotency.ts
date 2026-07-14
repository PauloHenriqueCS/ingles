import type { SupabaseClient } from '@supabase/supabase-js';
import type { WritingRewriteEvaluation } from '../domain/writing-rewrite/rewrite-types';
import {
  getEvaluationForAttempt,
} from './writingRewriteEvaluationRepository';

export interface IdempotencyResult {
  alreadyProcessed: boolean;
  existing?: WritingRewriteEvaluation;
}

/**
 * Check idempotency for rewrite evaluation.
 *
 * - status='completed': return { alreadyProcessed: true, existing: ... }
 * - status='pending': another in-flight — return { alreadyProcessed: false }
 * - no row: return { alreadyProcessed: false }
 */
export async function checkRewriteEvaluationIdempotency(
  supabase: SupabaseClient,
  rewriteSubmissionId: string,
  evaluationVersion: number,
): Promise<IdempotencyResult> {
  const evaluation = await getEvaluationForAttempt(supabase, rewriteSubmissionId, evaluationVersion);

  if (!evaluation) {
    return { alreadyProcessed: false };
  }

  if (evaluation.status === 'completed') {
    return { alreadyProcessed: true, existing: evaluation };
  }

  // 'pending' means another process is handling it — caller will try to acquire lease
  return { alreadyProcessed: false };
}
