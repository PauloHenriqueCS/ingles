/**
 * SERVER-ONLY: POST /api/writing-rewrite-evaluate
 *
 * Canonical (V2) writing-rewrite evaluation endpoint. Creates/reuses a
 * writing_rewrite_attempts draft for the given review, submits the
 * learner's rewrite text, and runs the full evaluateWritingRewrite
 * orchestrator (deterministic comparison + AI Gateway-routed model
 * evaluation under featureKey 'writing.evaluate_rewrite').
 *
 * This is the first real HTTP entry point for the canonical rewrite engine
 * (CANONICAL_WRITING_REWRITE_V2 — src/lib/writingRewriteFeatureFlags.ts).
 * Previously nothing in the app called evaluateWritingRewrite() at all.
 *
 * Submission/status transitions and evaluation persistence go through the
 * service-role client, never the caller's own session client — RLS on
 * writing_rewrite_attempts only allows users to manage 'draft' rows
 * directly; "submission and evaluation go through service role" (see
 * supabase/migrations/20260715010000_create_writing_rewrite_attempts.sql).
 * requireAuth is used only to authenticate the caller and derive userId —
 * ownership is re-verified in code against that userId before any write.
 */

import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, jsonError, safeLog } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { getSharedServiceClient } from './_ai-gateway/index';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';
import { checkFeatureConfigError } from './_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../src/domain/entitlements/entitlement-messages';
import { isRewriteV2Enabled } from '../src/lib/writingRewriteFeatureFlags';
import {
  createRewriteAttempt,
  getLatestRewriteAttempt,
  getNextRewriteSequence,
  updateRewriteText,
  updateRewriteAttemptStatus,
} from '../src/lib/writingRewriteRepository';
import { evaluateWritingRewrite } from '../src/lib/writingRewriteOrchestrator';
import { getEvaluationForAttempt } from '../src/lib/writingRewriteEvaluationRepository';
import { buildPublicRewriteDTO } from '../src/domain/writing-rewrite/rewrite-public-dto';
import { hashText } from '../src/domain/writing-rewrite/rewrite-normalization';

const MAX_REWRITE_TEXT_LENGTH = 15_000;
const EVALUATION_VERSION = 1;

// Statuses for which a same-content resubmission (retry / double-click /
// resend) must reuse the SAME attempt id rather than spawn a new one — never
// 'draft' (nothing submitted yet — a fresh attempt owns that text) and never
// 'cancelled'/'superseded' (terminal; a resubmission there is a genuinely new
// attempt).
const REUSABLE_IN_FLIGHT_STATUSES = new Set(['submitted', 'evaluation_pending', 'evaluation_failed']);

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.COMPARE)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  if (!isRewriteV2Enabled()) {
    return jsonError(res, 503, 'REWRITE_V2_DISABLED', 'A avaliação de reescrita não está disponível no momento.');
  }

  // Same plan gate as the legacy /api/compare-rewrite (writing.enabled) —
  // this is the canonical replacement for that flow's rewrite-evaluation
  // step and must never be reachable by a plan without writing access just
  // because it's a newer code path. No separate reviews.canStart re-check,
  // for the same reason documented in compare-rewrite.ts: this evaluates a
  // rewrite of a review the user already has, not a fresh review.
  let entitlements;
  try {
    entitlements = await getCurrentUserPlanEntitlements(userId);
  } catch {
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível verificar seu plano. Tente novamente.');
  }
  const writingConfigErrorCheck = checkFeatureConfigError(entitlements.writing.reviews);
  if (writingConfigErrorCheck) {
    return jsonError(res, 500, writingConfigErrorCheck.code!, writingConfigErrorCheck.message!);
  }
  if (!entitlements.writing.enabled) {
    return jsonError(res, 403, 'FEATURE_DISABLED', ENTITLEMENT_MESSAGES.featureUnavailable);
  }

  // Shares the same per-user throttle bucket as the legacy /api/compare-rewrite
  // endpoint (same class of action — evaluating a V2 rewrite) rather than
  // introducing a new RATE_LIMITS key, so a caller cannot double their
  // effective quota by hitting both endpoints for the same review.
  if (!await applyRateLimit(res, userId, 'compare-rewrite')) return;

  const { reviewId, rewriteText } = req.body ?? {};
  if (typeof reviewId !== 'string' || !reviewId.trim()) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'reviewId é obrigatório.');
  }
  if (typeof rewriteText !== 'string' || !rewriteText.trim() || rewriteText.length > MAX_REWRITE_TEXT_LENGTH) {
    return jsonError(res, 400, 'INVALID_REQUEST', `rewriteText é obrigatório e deve ter até ${MAX_REWRITE_TEXT_LENGTH} caracteres.`);
  }

  const supabase = getSharedServiceClient();

  const { data: reviewRow, error: reviewError } = await supabase
    .from('english_reviews')
    .select('id, user_id, original_text, corrected_text')
    .eq('id', reviewId)
    .single();

  if (reviewError || !reviewRow) {
    return jsonError(res, 404, 'REVIEW_NOT_FOUND', 'Revisão não encontrada.');
  }
  if ((reviewRow as { user_id: string }).user_id !== userId) {
    return jsonError(res, 403, 'FORBIDDEN', 'Esta revisão não pertence a este usuário.');
  }
  const review = reviewRow as { original_text: string | null; corrected_text: string | null };

  const trimmedRewriteText = rewriteText.trim();

  try {
    const latestAttempt = await getLatestRewriteAttempt(supabase, reviewId, userId);

    // Idempotent replay of an already-completed submission (retry / double
    // click / resend of the identical text) — evaluateWritingRewrite REJECTS
    // an attempt whose status is already 'evaluated' (only submitted /
    // evaluation_pending / evaluation_failed are evaluable), so this must be
    // handled here, not by calling the orchestrator again. Returns the exact
    // cached result; never re-runs the model.
    if (latestAttempt && latestAttempt.status === 'evaluated' && latestAttempt.rewriteText === trimmedRewriteText) {
      const evaluation = await getEvaluationForAttempt(supabase, latestAttempt.id, EVALUATION_VERSION);
      const dto = buildPublicRewriteDTO(latestAttempt, review.original_text ?? '', review.corrected_text ?? '', evaluation);
      safeLog('writing-rewrite-evaluate', 'idempotent_replay_evaluated', 200);
      return res.json({ result: dto });
    }

    // Same content already submitted and still in flight (or previously
    // failed) — reuse that SAME attempt id rather than create a new one, so
    // a double-click never produces two attempt rows for one logical
    // submission. A genuinely concurrent double call sharing this exact
    // attempt id is still bounded by evaluateWritingRewrite's own
    // idempotency check plus the DB UNIQUE constraint on
    // (rewrite_submission_id, evaluation_version) in writing_rewrite_evaluations
    // — the second writer fails cleanly instead of persisting a duplicate row.
    const reuseInFlightAttempt = !!latestAttempt
      && REUSABLE_IN_FLIGHT_STATUSES.has(latestAttempt.status)
      && latestAttempt.rewriteText === trimmedRewriteText;

    let attemptId: string;
    if (reuseInFlightAttempt) {
      attemptId = latestAttempt!.id;
    } else {
      let attempt = latestAttempt;
      if (!attempt || attempt.status !== 'draft') {
        const rewriteSequence = await getNextRewriteSequence(supabase, reviewId, userId);
        attempt = await createRewriteAttempt(supabase, {
          userId,
          reviewId,
          rewriteSequence,
          originalTextSnapshot: review.original_text ?? '',
          correctedTextHash: hashText(review.corrected_text ?? ''),
          reviewVersion: 1,
        });
      }
      attempt = await updateRewriteText(supabase, attempt.id, trimmedRewriteText);
      attempt = await updateRewriteAttemptStatus(supabase, attempt.id, 'submitted', new Date().toISOString());
      attemptId = attempt.id;
    }

    const dto = await evaluateWritingRewrite(supabase, {
      authenticatedUserId: userId,
      rewriteSubmissionId: attemptId,
      clientRequestId: `writing-rewrite-evaluate:${attemptId}`,
    });

    safeLog('writing-rewrite-evaluate', 'success', 200);
    return res.json({ result: dto });
  } catch (err) {
    safeLog('writing-rewrite-evaluate', 'error', 500, { message: String(err instanceof Error ? err.message : err) });
    return jsonError(res, 500, 'EVALUATION_FAILED', 'Não foi possível avaliar sua reescrita agora.');
  }
}
