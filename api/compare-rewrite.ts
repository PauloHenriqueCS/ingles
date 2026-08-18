import { createHash } from 'crypto';
import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens, DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE } from './_ai-gateway/index';
import type { GatewayUsageMetric, DedupeBeginResult } from './_ai-gateway/index';
import { getCurriculumServiceClient } from './_curriculum/service-client';
import { resolveActivityPrompt, CurriculumConfigError } from './_curriculum/curriculum-runtime';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';
import { checkFeatureConfigError } from './_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../src/domain/entitlements/entitlement-messages';
import { getProductConfig, isWithinConfiguredWindow, resolveConfigEnvironment } from '../src/server/product-config';
import { validateRewriteText } from '../src/domain/writing-rewrite/rewrite-text-validation';
import { normalizeForComparison } from '../src/domain/text/text-normalization';
import { evaluateOutputLanguage } from '../src/domain/language/language-guard';
import type { SupabaseClient } from '@supabase/supabase-js';

const AI_MODEL = 'gpt-4o-mini';

/**
 * Item 9: the "Revisado" state means the final corrected version has been
 * generated and persisted. Promote the writing_entries row for the review's
 * day to 'revisado' (idempotent, RLS-scoped, best-effort — never blocks the
 * response). No-op when the entry date is unknown or already 'revisado'.
 */
async function promoteEntryToRevisado(
  supabase: SupabaseClient,
  userId: string,
  entryDate: string | null,
): Promise<void> {
  if (!entryDate) return;
  try {
    await supabase
      .from('writing_entries')
      .update({ status: 'revisado' })
      .eq('user_id', userId)
      .eq('entry_date', entryDate)
      .neq('status', 'revisado');
  } catch {
    /* non-fatal: status promotion never blocks returning the final text */
  }
}

/**
 * AI Gateway idempotency (reuses SupabaseDedupeStore / begin-complete-fail
 * _gateway_idempotent_op_v1 — the same generic locks used by the enforce-mode
 * pipeline, see api/_ai-gateway/enforcement.ts). This endpoint calls the
 * dedupe store directly instead of going through executeAiGatewayCall's
 * context.idempotencyKey, because it needs the full begin() outcome
 * (started/reclaimed/in_progress/completed) to decide whether to serve a
 * persisted result, ask the client to wait, or proceed — the enforce
 * pipeline collapses 'in_progress' and 'completed' into the same
 * DUPLICATE_IN_PROGRESS GatewayError, which isn't enough to implement that.
 * One fixed scope for the whole endpoint; the operation name is embedded in
 * the idempotency key itself so the two flows below can never collide.
 */
const DEDUPE_SCOPE = 'compare-rewrite';
const DEDUPE_LEASE_SECONDS = 120;

/** Deterministic content fingerprint — never the raw text itself, only its hash. */
function hashNormalizedContent(parts: string[]): string {
  const normalized = parts.map((p) => normalizeForComparison(p)).join(' ');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * `{reviewId or userId}:{hash}` — reviewId (when present) already scopes the
 * key to one user's one review; userId is the fallback for the no-reviewId
 * path so two different users' identical text never collides.
 */
function buildFinalTextIdempotencyKey(scopeId: string, rewriteText: string): string {
  return `writing.correct_v2_text:${scopeId}:${hashNormalizedContent([rewriteText])}`;
}

function buildCompareIdempotencyKey(scopeId: string, originalText: string, rewriteText: string): string {
  return `writing.compare_rewrite:${scopeId}:${hashNormalizedContent([originalText, rewriteText])}`;
}

const DUPLICATE_IN_PROGRESS_MESSAGE = 'Esta solicitação já está sendo processada. Aguarde alguns instantes e tente novamente.';

interface StoredFinalTextLookup {
  entryDate: string | null;
  /** Non-null only when a final text is already persisted AND the V2 hasn't changed meaningfully. */
  reusableFinalText: string | null;
}

/**
 * Re-checks english_reviews for an already-persisted, still-matching final
 * text. Used both by the up-front idempotent-retry check and by the dedupe
 * 'completed' branch (a concurrent request may have finished and persisted
 * between this request's begin() call and now).
 */
async function lookupStoredFinalText(
  supabase: SupabaseClient,
  userId: string,
  reviewIdRaw: string,
  rewriteText: string,
): Promise<StoredFinalTextLookup | null> {
  if (!reviewIdRaw) return null;
  const { data: existing } = await supabase
    .from('english_reviews')
    .select('version_2_text, version_2_final_text, entry_date')
    .eq('id', reviewIdRaw)
    .eq('user_id', userId)
    .maybeSingle();
  if (!existing) return null;
  const entryDate = (existing.entry_date as string | null) ?? null;
  const storedFinal = typeof existing.version_2_final_text === 'string' ? existing.version_2_final_text.trim() : '';
  const storedV2 = typeof existing.version_2_text === 'string' ? existing.version_2_text : '';
  // "Changed meaningfully" ignores trivial edits (case, spacing, curly
  // apostrophes, trailing sentence punctuation) — same normalization used to
  // derive the idempotency key itself, so a trivial edit never mints a new
  // key AND never fails this reuse check either.
  const unchanged = normalizeForComparison(storedV2) === normalizeForComparison(rewriteText);
  return { entryDate, reusableFinalText: storedFinal && unchanged ? storedFinal : null };
}

/**
 * Renders the "principais erros da primeira revisão" block passed to the
 * comparison prompt via {{main_mistakes}}. The pedagogical framing lives in
 * the DB template; this only formats the caller-supplied error list into the
 * same numbered text the previous hardcoded prompt used. Never empty (the
 * template's required placeholder must resolve to a non-empty value).
 */
function buildMainMistakesText(
  mainMistakes: { original: string; correct: string; explanation: string }[],
): string {
  if (mainMistakes.length === 0) return '(nenhum erro específico listado na primeira revisão)';
  const lines: string[] = [];
  mainMistakes.forEach((m, i) => {
    lines.push(`${i + 1}. Você escreveu: "${m.original}" → Correto: "${m.correct}"`);
    if (m.explanation) lines.push(`   Explicação: ${m.explanation}`);
  });
  return lines.join('\n');
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractCompareMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
  const metrics: GatewayUsageMetric[] = [];

  // Always record one request per provider call.
  metrics.push({
    metricKey: 'provider_requests',
    unitType: 'request',
    quantity: 1,
    isBillable: false,
    measurementSource: 'provider_response',
  });

  const usage = completion.usage;
  if (!usage) return metrics;

  if (usage.prompt_tokens != null) {
    metrics.push({
      metricKey: 'input_text_tokens',
      unitType: 'token',
      quantity: usage.prompt_tokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  if (usage.completion_tokens != null) {
    metrics.push({
      metricKey: 'output_text_tokens',
      unitType: 'token',
      quantity: usage.completion_tokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  // Only record when actually provided and non-zero — do not invent values.
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens != null && cachedTokens > 0) {
    metrics.push({
      metricKey: 'cached_input_tokens',
      unitType: 'token',
      quantity: cachedTokens,
      // Cached tokens are billed at a discounted rate, not free — priced
      // separately from the non-cached share of input_text_tokens.
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  return metrics;
}

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.COMPARE)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  // Rewrite V2 (compare + final correction) is a continuation of a review
  // the user already started under writing.reviews' quota — only the
  // feature's on/off flag is re-checked here, never a fresh reviews.canStart,
  // so an already-authorized V2 attempt is never blocked mid-flow by the
  // review counter. A plan with writing entirely disabled must still never
  // reach this endpoint, cached-final-text backfill mode included.
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
  const writingFlag = (await getProductConfig(resolveConfigEnvironment())).values['features.writing'];
  if (!writingFlag.enabled && isWithinConfiguredWindow(writingFlag.startsAt, writingFlag.endsAt)) {
    return jsonError(res, 403, 'FEATURE_DISABLED', writingFlag.unavailableMessage);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de comparação não está configurado.');

  const { originalText, correctedText, rewriteText, mainMistakes, generateFinalTextOnly, reviewId } = req.body ?? {};

  // ── Mode: generate the final corrected text (idempotent), attaching it to a review
  if (generateFinalTextOnly === true) {
    if (!correctedText?.trim() || !rewriteText?.trim()) {
      return jsonError(res, 400, 'INVALID_REQUEST', 'correctedText e rewriteText são obrigatórios.');
    }

    // Same authoritative content-quality gate as /api/writing-rewrite-evaluate
    // — never trust the frontend check alone. Rejected before any AI call,
    // so a garbage rewriteText never consumes an AI Gateway request here.
    const contentCheck = validateRewriteText(rewriteText);
    if (!contentCheck.valid) {
      safeLog('compare-rewrite', 'invalid_content_rejected', 400, { reasonCode: contentCheck.reasonCode!, mode: 'final_text_only' });
      return jsonError(res, 400, 'INVALID_REWRITE_TEXT', contentCheck.message!);
    }

    const reviewIdRaw = typeof reviewId === 'string' ? reviewId.trim() : '';
    let entryDate: string | null = null;

    // ── Idempotency: if a final version is already persisted for this review AND
    // the student's V2 text hasn't meaningfully changed (comparison ignores case/
    // spacing/quotes), return the stored text WITHOUT calling the AI. This covers
    // reopening the screen, page refresh, a timeout retry after the AI already
    // answered — the common case, resolved with zero Gateway/lock overhead.
    const upfrontLookup = await lookupStoredFinalText(supabase, userId, reviewIdRaw, rewriteText);
    if (upfrontLookup) {
      entryDate = upfrontLookup.entryDate;
      if (upfrontLookup.reusableFinalText) {
        safeLog('compare-rewrite', 'final_only_reused', 200, { reused: true });
        await promoteEntryToRevisado(supabase, userId, entryDate);
        return res.json({ finalCorrectedText: upfrontLookup.reusableFinalText, persisted: true, reused: true });
      }
    }

    // Data-driven prompt (DB-sourced; no hardcoded English fallback). Review /
    // rewrite is NOT part of curricular progression → requireSubtopic:false and
    // NO practice is recorded. CurriculumConfigError surfaces as an explicit
    // operational error rather than a silent English prompt.
    let correctSystem: string;
    let correctUser: string;
    let expectedLang: string;
    try {
      const resolved = await resolveActivityPrompt(getCurriculumServiceClient(), userId, {
        templateKey: 'writing.correct_v2_text',
        activityType: 'writing',
        requireSubtopic: false,
        userContext: { corrected_text: correctedText.trim(), rewrite_text: rewriteText.trim() },
      });
      correctSystem = resolved.system;
      correctUser = resolved.user ?? '';
      // The corrected version MUST stay in the student's learning language; the
      // guard below verifies the model actually honoured that.
      expectedLang = resolved.languageContext.learningLanguage;
    } catch (err) {
      if (err instanceof CurriculumConfigError) {
        safeLog('compare-rewrite', 'curriculum_config_error', 500, { mode: 'final_text_only' });
        return jsonError(res, 500, 'CURRICULUM_CONFIG_ERROR', 'O serviço está temporariamente indisponível. Tente novamente.');
      }
      throw err;
    }

    if (!await applyRateLimit(res, userId, 'compare-rewrite')) return;

    // ── Gateway context — created only once auth/validation/rate-limit have
    // passed, so an early rejection never depends on gateway infrastructure
    // (mirrors review-text.ts / generate-theme.ts). This is its own HTTP
    // request, so it gets its own fresh correlationId.
    const gatewayDeps = getProductionDeps();
    const correlationId = gatewayDeps.uuidGen();
    let physicalAttempt = 0;

    // ── Concurrency dedup — closes the gap the up-front check above can't:
    // two requests racing with the same (reviewId-or-userId, normalized V2)
    // arrive before either has persisted anything. begin() lets exactly one
    // through; the other gets 'in_progress' (still running) or 'completed'
    // (finished between this request's upfront lookup and its begin() call)
    // and never calls the AI.
    const dedupeStore = gatewayDeps.dedupeStore;
    const finalTextIdemKey = buildFinalTextIdempotencyKey(reviewIdRaw || userId, rewriteText);
    let dedupeLockId: string | null = null;
    if (dedupeStore) {
      let begin: DedupeBeginResult;
      try {
        begin = await dedupeStore.begin(DEDUPE_SCOPE, finalTextIdemKey, DEDUPE_LEASE_SECONDS);
      } catch {
        safeLog('compare-rewrite', 'dedupe_unavailable', 503, { mode: 'final_text_only' });
        return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço está temporariamente indisponível. Tente novamente.');
      }
      if (begin.outcome === 'in_progress' || begin.outcome === 'completed') {
        if (begin.outcome === 'completed') {
          const raceLookup = await lookupStoredFinalText(supabase, userId, reviewIdRaw, rewriteText);
          if (raceLookup?.reusableFinalText) {
            safeLog('compare-rewrite', 'final_only_reused', 200, { reused: true, viaDedupe: true });
            await promoteEntryToRevisado(supabase, userId, raceLookup.entryDate);
            return res.json({ finalCorrectedText: raceLookup.reusableFinalText, persisted: true, reused: true });
          }
        }
        safeLog('compare-rewrite', 'dedupe_in_progress', 409, { mode: 'final_text_only', outcome: begin.outcome });
        return jsonError(res, 409, 'DUPLICATE_REQUEST_IN_PROGRESS', DUPLICATE_IN_PROGRESS_MESSAGE);
      }
      dedupeLockId = begin.lockId;
    }

    try {
      const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });

      // Generate, then verify the output language. If the model drifts into the
      // wrong/mixed language (the reported "Versão final corrigida" bug), retry
      // ONCE with a reinforced instruction; never silently accept a bad result.
      const MAX_LANGUAGE_ATTEMPTS = 2;
      let finalCorrectedText = '';
      let lastGuardFailed = false;
      for (let attempt = 0; attempt < MAX_LANGUAGE_ATTEMPTS; attempt++) {
        const reinforcement = attempt === 0
          ? ''
          : '\n\n=== RETRY: LANGUAGE ERROR ===\nYour previous output was not entirely in the student\'s learning language. Output the corrected text ONLY in that language. Do not translate any part of it and do not mix languages.';
        physicalAttempt += 1;
        const completion = await executeAiGatewayCall<ChatCompletion>(
          {
            featureKey: 'writing.correct_v2_text',
            provider: 'openai',
            service: 'chat.completions',
            model: AI_MODEL,
            userId,
            initiatedByUserId: userId,
            actorType: 'user',
            executionLocation: 'backend',
            correlationId,
            attemptNumber: physicalAttempt,
            callSequence: 1,
            technicalMetadata: {
              endpoint: 'compare-rewrite',
              operation: 'final_correction',
              physicalAttempt,
              flowType: 'final_text_only',
            },
            estimatedMetrics: estimateTextTokens(
              correctSystem.length + correctUser.length,
              DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
            ),
          },
          () => openai.chat.completions.create({
            model: AI_MODEL,
            temperature: 0.2,
            messages: [
              { role: 'system', content: correctSystem + reinforcement },
              { role: 'user', content: correctUser },
            ],
          }),
          gatewayDeps,
          extractCompareMetrics,
        );
        const candidate = (completion.choices[0]?.message?.content ?? '').trim();
        if (!candidate) throw new Error('Resposta vazia');
        finalCorrectedText = candidate;

        const guard = evaluateOutputLanguage(candidate, expectedLang);
        if (guard.ok) { lastGuardFailed = false; break; }
        lastGuardFailed = true;
        safeLog('compare-rewrite', 'final_only_language_guard', 200, {
          attempt: attempt + 1, reason: guard.reason ?? null, detected: guard.detected ?? null,
        });
      }

      // Never persist/return an evidently wrong- or mixed-language correction.
      if (lastGuardFailed) {
        if (dedupeLockId) await dedupeStore!.fail(dedupeLockId).catch(() => undefined);
        safeLog('compare-rewrite', 'final_only_language_rejected', 502, {});
        return jsonError(res, 502, 'AI_WRONG_LANGUAGE', 'A correção saiu no idioma errado. Tente novamente.');
      }

      // Persist server-side so a later retry/refresh finds the result without a
      // new AI call, and promote the day to 'revisado'. Bound to the review row
      // (RLS-scoped); the client is told whether persistence happened so it can
      // fall back to its own save only when no reviewId was provided.
      let persisted = false;
      if (reviewIdRaw) {
        const { error: updateErr } = await supabase
          .from('english_reviews')
          .update({ version_2_final_text: finalCorrectedText })
          .eq('id', reviewIdRaw)
          .eq('user_id', userId);
        if (updateErr) {
          safeLog('compare-rewrite', 'final_only_persist_error', 200, { nonFatal: true });
        } else {
          persisted = true;
          await promoteEntryToRevisado(supabase, userId, entryDate);
        }
      }
      if (dedupeLockId) await dedupeStore!.complete(dedupeLockId, reviewIdRaw || null).catch(() => undefined);
      safeLog('compare-rewrite', 'final_only_success', 200, { persisted });
      return res.json({ finalCorrectedText, persisted });
    } catch (err) {
      if (dedupeLockId) await dedupeStore!.fail(dedupeLockId).catch(() => undefined);
      const { code, status } = sanitizeProviderError(err);
      safeLog('compare-rewrite', 'final_only_error', status, { code });
      if (code === 'AI_TIMEOUT') return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
      return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
    }
  }

  // ── Mode: compare V2 (default) + generate final corrected text
  if (!originalText?.trim() || !correctedText?.trim() || !rewriteText?.trim()) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'originalText, correctedText e rewriteText são obrigatórios.');
  }
  if (
    typeof originalText !== 'string' || originalText.length > 15_000 ||
    typeof correctedText !== 'string' || correctedText.length > 15_000 ||
    typeof rewriteText !== 'string' || rewriteText.length > 15_000
  ) {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'O conteúdo enviado é maior que o permitido.');
  }

  const legacyContentCheck = validateRewriteText(rewriteText);
  if (!legacyContentCheck.valid) {
    safeLog('compare-rewrite', 'invalid_content_rejected', 400, { reasonCode: legacyContentCheck.reasonCode!, mode: 'compare_and_correct' });
    return jsonError(res, 400, 'INVALID_REWRITE_TEXT', legacyContentCheck.message!);
  }

  if (!await applyRateLimit(res, userId, 'compare-rewrite')) return;

  // ── Data-driven prompts (DB-sourced; no hardcoded English fallback) ────────
  // Both the comparison and the final-correction prompts come from the DB.
  // Review / rewrite is NOT part of curricular progression → requireSubtopic:
  // false and NO practice is recorded. Resolved up-front (before any dedupe
  // lock is held) so a CurriculumConfigError returns an explicit operational
  // error without stranding a lock.
  let compareSystem: string;
  let compareUser: string;
  let correctSystem: string;
  let correctUser: string;
  try {
    const compareResolved = await resolveActivityPrompt(getCurriculumServiceClient(), userId, {
      templateKey: 'writing.compare_rewrite',
      activityType: 'writing',
      requireSubtopic: false,
      userContext: {
        original_text: originalText.trim(),
        corrected_text: correctedText.trim(),
        rewrite_text: rewriteText.trim(),
        main_mistakes: buildMainMistakesText(Array.isArray(mainMistakes) ? mainMistakes : []),
      },
    });
    compareSystem = compareResolved.system;
    compareUser = compareResolved.user ?? '';
    const correctResolved = await resolveActivityPrompt(getCurriculumServiceClient(), userId, {
      templateKey: 'writing.correct_v2_text',
      activityType: 'writing',
      requireSubtopic: false,
      userContext: { corrected_text: correctedText.trim(), rewrite_text: rewriteText.trim() },
    });
    correctSystem = correctResolved.system;
    correctUser = correctResolved.user ?? '';
  } catch (err) {
    if (err instanceof CurriculumConfigError) {
      safeLog('compare-rewrite', 'curriculum_config_error', 500, { mode: 'compare_and_correct' });
      return jsonError(res, 500, 'CURRICULUM_CONFIG_ERROR', 'O serviço está temporariamente indisponível. Tente novamente.');
    }
    throw err;
  }

  // ── Gateway context — one correlationId per HTTP request, one physical-
  // attempt counter shared across both physical calls made below (comparison
  // then, best-effort, final correction). Created only after auth/validation/
  // rate-limit have passed (mirrors review-text.ts / generate-theme.ts).
  const gatewayDeps = getProductionDeps();
  const correlationId = gatewayDeps.uuidGen();
  let physicalAttempt = 0;

  // ── Concurrency dedup — one lock covers the whole flow (comparison +
  // best-effort final correction), keyed by the review/user + normalized
  // (original, rewrite) content.
  //
  // 'in_progress' means a physically concurrent call is genuinely still
  // running — the "wait and try again" response is honest there.
  //
  // 'completed' means a prior call with this exact content already finished
  // (complete() only ever runs after invoke() has returned). This mode has
  // no persisted result to replay from (unlike generateFinalTextOnly's
  // english_reviews.version_2_final_text) — result/finalCorrectedText only
  // ever live in the HTTP response, never written to the DB. Treating
  // 'completed' as "still in progress" would be false, and blocking until
  // the lock's own TTL elapses (begin_gateway_idempotent_op_v1 never resets
  // expires_at on complete()/fail() — it's fixed at the original begin()
  // call, DEDUPE_LEASE_SECONDS out — and reclaim there needs a fresh
  // begin() call, not something complete()/fail() can force early) would
  // strand a client whose retry only exists because the original response
  // was lost in transit. The one safe option left is to generate fresh for
  // THIS retry. That does not reopen the concurrent-duplicate hole dedupe
  // closes above: 'completed' is only ever observed once the original
  // attempt's own complete() call has already run, i.e. never while a
  // request for this content is still in flight — genuinely-concurrent
  // duplicates always land on 'in_progress' instead, still fully blocked.
  const dedupeStore = gatewayDeps.dedupeStore;
  const compareIdemKey = buildCompareIdempotencyKey(
    (typeof reviewId === 'string' && reviewId.trim()) || userId,
    originalText,
    rewriteText,
  );
  let dedupeLockId: string | null = null;
  if (dedupeStore) {
    let begin: DedupeBeginResult;
    try {
      begin = await dedupeStore.begin(DEDUPE_SCOPE, compareIdemKey, DEDUPE_LEASE_SECONDS);
    } catch {
      safeLog('compare-rewrite', 'dedupe_unavailable', 503, { mode: 'compare_and_correct' });
      return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço está temporariamente indisponível. Tente novamente.');
    }
    if (begin.outcome === 'in_progress') {
      safeLog('compare-rewrite', 'dedupe_in_progress', 409, { mode: 'compare_and_correct' });
      return jsonError(res, 409, 'DUPLICATE_REQUEST_IN_PROGRESS', DUPLICATE_IN_PROGRESS_MESSAGE);
    }
    if (begin.outcome === 'completed') {
      // No lock held for this attempt: the stale lock isn't ours to mutate
      // (complete()/fail() below both no-op without a truthy dedupeLockId),
      // and it isn't reclaimable early — only its own TTL expiry allows a
      // fresh begin() to reclaim it. Proceed straight to generation instead
      // of leaving the caller stuck on a false "in progress".
      safeLog('compare-rewrite', 'dedupe_completed_no_replay', 200, { mode: 'compare_and_correct' });
    } else {
      dedupeLockId = begin.lockId;
    }
  }

  try {
    const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });

    physicalAttempt += 1;
    const completion = await executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'writing.compare_rewrite',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId,
        attemptNumber: physicalAttempt,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'compare-rewrite',
          operation: 'comparison',
          physicalAttempt,
          flowType: 'compare_and_correct',
        },
        estimatedMetrics: estimateTextTokens(
          compareSystem.length + compareUser.length,
          DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
        ),
      },
      () => openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: compareSystem },
          { role: 'user', content: compareUser },
        ],
      }),
      gatewayDeps,
      extractCompareMetrics,
    );

    const raw = completion.choices[0]?.message?.content ?? '';

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        if (dedupeLockId) await dedupeStore!.fail(dedupeLockId).catch(() => undefined);
        return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      }
      try { parsed = JSON.parse(match[0]); }
      catch {
        if (dedupeLockId) await dedupeStore!.fail(dedupeLockId).catch(() => undefined);
        return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      }
    }

    const result = {
      improvementScore: Number(parsed.improvementScore) || 0,
      fixedMistakesCount: Number(parsed.fixedMistakesCount) || 0,
      remainingMistakesCount: Number(parsed.remainingMistakesCount) || 0,
      fixedMistakes: Array.isArray(parsed.fixedMistakes) ? parsed.fixedMistakes : [],
      remainingMistakes: Array.isArray(parsed.remainingMistakes) ? parsed.remainingMistakes : [],
      newIssues: Array.isArray(parsed.newIssues) ? parsed.newIssues : [],
      overallFeedback: String(parsed.overallFeedback || 'Análise concluída.'),
      nextAction: String(parsed.nextAction || 'Continue praticando!'),
    };

    // Generate final corrected text (best-effort — comparison result is returned even if this fails)
    let finalCorrectedText: string | undefined;
    try {
      physicalAttempt += 1;
      const correction = await executeAiGatewayCall<ChatCompletion>(
        {
          featureKey: 'writing.correct_v2_text',
          provider: 'openai',
          service: 'chat.completions',
          model: AI_MODEL,
          userId,
          initiatedByUserId: userId,
          actorType: 'user',
          executionLocation: 'backend',
          correlationId,
          attemptNumber: physicalAttempt,
          callSequence: 1,
          technicalMetadata: {
            endpoint: 'compare-rewrite',
            operation: 'final_correction',
            physicalAttempt,
            flowType: 'compare_and_correct',
          },
          estimatedMetrics: estimateTextTokens(
            correctSystem.length + correctUser.length,
            DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
          ),
        },
        () => openai.chat.completions.create({
          model: AI_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: correctSystem },
            { role: 'user', content: correctUser },
          ],
        }),
        gatewayDeps,
        extractCompareMetrics,
      );
      const corrected = (correction.choices[0]?.message?.content ?? '').trim();
      if (corrected) finalCorrectedText = corrected;
    } catch (corrErr) {
      const { code, status } = sanitizeProviderError(corrErr);
      safeLog('compare-rewrite', 'final_text_error', status, { code, nonFatal: true });
    }

    if (dedupeLockId) await dedupeStore!.complete(dedupeLockId, null).catch(() => undefined);
    safeLog('compare-rewrite', 'success', 200, { hasFinalText: finalCorrectedText !== undefined });
    return res.json({ result, ...(finalCorrectedText ? { finalCorrectedText } : {}) });
  } catch (err) {
    if (dedupeLockId) await dedupeStore!.fail(dedupeLockId).catch(() => undefined);
    const { code, status } = sanitizeProviderError(err);
    if (code === 'AI_TIMEOUT') {
      safeLog('compare-rewrite', 'timeout', status);
      return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
    }
    safeLog('compare-rewrite', 'provider_error', status);
    return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
  }
}
