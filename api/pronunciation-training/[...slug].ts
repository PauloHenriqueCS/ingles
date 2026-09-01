import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog, sanitizeProviderError, resolveSlug } from '../_helpers';
import { recordBehavioralPushActivityConversion } from '../_push/attribution';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import { assessPronunciation } from '../_azure-pronunciation';
import { PronunciationServiceError } from '../../src/domain/pronunciation/pronunciation-scoring';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens, getSharedServiceClient, mapPronunciationFailCodeToProviderSignal, recordAndAlertBrowserProviderFailure } from '../_ai-gateway/index';
import type { GatewayUsageMetric } from '../_ai-gateway/index';
import { applyRateLimit } from '../_rateLimit';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { getCurriculumServiceClient } from '../_curriculum/service-client';
import { resolveActivityPrompt, recordCurricularPracticeFromIdentity, ensureUserCurriculum, CurriculumConfigError } from '../_curriculum/curriculum-runtime';
import { resolveUserSpeechConfig, getLanguageSpeechConfig, SpeechConfigError, SAFE_AZURE_VOICE_RE } from '../_curriculum/language-speech-config';
import { getOrCreateSharedContent, levelCodeFromSubtopicKey, SHARED_CONTENT_AUDIO_BUCKET, type SharedContentAudioSpec } from '../_shared-content/get-or-create-shared-content';
import { synthesizeSpeech } from '../_azure-tts';
import { checkFeatureConfigError, checkRecordingDuration } from '../_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../../src/domain/entitlements/entitlement-messages';
import { evaluateSkillPromotion } from '../../src/lib/promotionService';
import type { PromotionTrigger } from '../../src/domain/promotion/promotion-types';
import type { PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';
import type { PronunciationNormalizedResult, PronunciationFailCode } from '../../src/types';
import { isValidUuid } from '../../src/lib/pronunciationAssessment';
import { getTodaySP } from '../../src/lib/timezone';
import { getProductConfig, isWithinConfiguredWindow, resolveConfigEnvironment } from '../../src/server/product-config';
import {
  WORD_PRACTICE_MAX_ATTEMPTS,
  WORD_PRACTICE_MAX_DURATION_SECONDS,
  isWordPracticeOwnerType,
  type WordPracticeOwnerType,
} from '../../src/domain/pronunciation/word-practice-limits';

type AccessDenial = { status: number; code: string; message: string };

// "Treinar pronúncia" (PronunciationTrainingView) is a standalone practice
// flow, distinct from the plan-metered pronunciation.evaluations quota used
// by api/pronunciation/[...slug].ts's official assessment (start/complete)
// for the writing flow. It was previously reachable with NO entitlement
// check at all — a plan with pronunciation.enabled=false could still call
// generate-text (OpenAI cost) and token (Azure Speech STS) directly,
// bypassing the "disabled_by_plan" lock HomePage shows for the same card.
// This gate applies only the on/off flag — per-day counting for the
// standalone text/evaluation limits is enforced separately (see
// checkDailyPronunciationTrainingAllowed below), scoped to its own table
// (pronunciation_training_sessions), never touching the writing flow's
// pronunciation_assessments counter.
async function requirePronunciationEnabled(userId: string): Promise<AccessDenial | { entitlements: PlanEntitlementsSnapshot }> {
  let entitlements: PlanEntitlementsSnapshot;
  try {
    entitlements = await getCurrentUserPlanEntitlements(userId);
  } catch {
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Não foi possível verificar seu plano. Tente novamente.' };
  }
  const configErrorCheck = checkFeatureConfigError(entitlements.pronunciation.evaluations);
  if (configErrorCheck) return { status: 500, code: configErrorCheck.code!, message: configErrorCheck.message! };
  if (!entitlements.pronunciation.enabled) {
    return { status: 403, code: 'FEATURE_DISABLED', message: ENTITLEMENT_MESSAGES.featureUnavailable };
  }
  const pronunciationFlag = (await getProductConfig(resolveConfigEnvironment())).values['features.pronunciation'];
  if (!pronunciationFlag.enabled && isWithinConfiguredWindow(pronunciationFlag.startsAt, pronunciationFlag.endsAt)) {
    return { status: 403, code: 'FEATURE_DISABLED', message: pronunciationFlag.unavailableMessage };
  }
  return { entitlements };
}

function isAccessDenial(v: AccessDenial | { entitlements: PlanEntitlementsSnapshot }): v is AccessDenial {
  return 'status' in v;
}

/**
 * CONVERGENT curricular credit for a completed pronunciation training session
 * (blockers 5, 6.B). Idempotent: safe on first completion AND on a retry of an
 * already-completed assessment. Records against the recorte the session was
 * GENERATED for (persisted on the session) — never the current pointer, never a
 * client value. A session without a persisted identity grants no credit.
 */
async function reconcilePronunciationCredit(userId: string, sessionId: string): Promise<void> {
  const svc = getCurriculumServiceClient();
  const { data: sessionRow } = await svc
    .from('pronunciation_training_sessions')
    .select('curriculum_version_id, curriculum_subtopic_key')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  const sr = sessionRow as { curriculum_version_id?: string | null; curriculum_subtopic_key?: string | null } | null;
  const identity = sr?.curriculum_version_id && sr.curriculum_subtopic_key
    ? { versionId: sr.curriculum_version_id, subtopicKey: sr.curriculum_subtopic_key }
    : null;
  const rec = await recordCurricularPracticeFromIdentity(svc, userId, 'pronunciation', sessionId, identity);
  if (rec.recorded) {
    await svc.from('pronunciation_training_sessions').update({ curriculum_credit_status: 'credited' }).eq('id', sessionId).eq('user_id', userId);
  } else if (!identity) {
    safeLog('pronunciation-training/complete', 'no_curricular_identity', 200, { sessionId });
  }
}

/**
 * Defense-in-depth on top of pronunciation.enabled: a plan could in theory
 * be enabled but configured with a 0/day (non-unlimited) evaluations limit.
 * Every real plan today keeps these two flags together (see the
 * "desligado" plan), but this must still be read from entitlements, never
 * assumed — rule 4 of the task ("ler os valores do plano; não fixar '1' ou
 * '60' apenas no frontend") applies to the backend gate too.
 */
function dailyPronunciationTrainingAllowedByPlan(entitlements: PlanEntitlementsSnapshot): boolean {
  return entitlements.pronunciation.evaluations.unlimited || entitlements.pronunciation.evaluations.limit >= 1;
}

const AI_MODEL = 'gpt-4o-mini';
const GENERATE_TIMEOUT_MS = 30_000;

// Thrown inside the shared-content generateContent callback when the provider
// returns empty text, so the item is marked failed (never a valid hit) and the
// caller maps it to the same 503 AI_UNAVAILABLE as before.
class SharedPronunciationTextEmptyError extends Error {
  constructor() {
    super('PRONUNCIATION_TEXT_EMPTY');
    this.name = 'SharedPronunciationTextEmptyError';
  }
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractGenerateTextMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
  const metrics: GatewayUsageMetric[] = [];

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

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens != null && cachedTokens > 0) {
    metrics.push({
      metricKey: 'cached_input_tokens',
      unitType: 'token',
      quantity: cachedTokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  return metrics;
}

// ─── POST /api/pronunciation-training/generate-text ──────────────────────────
// Get-or-create the day's single practice text (America/Sao_Paulo). A row
// already existing for today is returned as-is — including a saved result
// when the day's evaluation is already completed — and the AI provider is
// never called in that case, satisfying "ao recarregar... retornar o mesmo
// texto já gerado, sem fazer outra chamada de IA".

interface TrainingSessionRow {
  id: string;
  level: string;
  generated_text: string;
  status: string;
  pronunciation_score: number | null;
  accuracy_score: number | null;
  fluency_score: number | null;
  completeness_score: number | null;
  prosody_score: number | null;
  recognized_text: string | null;
  words_json: unknown;
  raw_result_json: unknown;
  audio_duration_seconds: number | null;
  shared_content_item_id?: string | null;
}

// Shape of the additive `audio` field returned alongside the practice text: the
// persisted/shared reference TTS (base64), so the client plays it directly
// instead of calling /api/tts. `voice` lets the client honour a user-chosen
// non-default voice (fall back to /api/tts) while the default case reuses cache.
interface SharedReferenceAudio { base64: string; mimeType: string; voice: string | null; locale: string | null; }

/**
 * Loads the persisted reference TTS for a session's shared library item, if it
 * has one with READY audio. Returns null (client falls back to /api/tts) when
 * there is no item, no ready audio, or on ANY error — never throws, never calls a
 * provider. Used on the reentry/early-return paths so reopening the activity the
 * same day reuses the cached audio with no new Azure call.
 */
async function loadSharedReferenceAudio(
  serviceClient: any,
  sharedItemId: string | null | undefined,
): Promise<SharedReferenceAudio | null> {
  if (!sharedItemId) return null;
  try {
    const { data } = await serviceClient
      .from('shared_content_items')
      .select('audio_status, audio_path, audio_mime_type, audio_voice, audio_locale')
      .eq('id', sharedItemId)
      .maybeSingle();
    const row = data as { audio_status?: string; audio_path?: string | null; audio_mime_type?: string | null; audio_voice?: string | null; audio_locale?: string | null } | null;
    if (!row || row.audio_status !== 'ready' || !row.audio_path) return null;
    const { data: file, error } = await serviceClient.storage.from(SHARED_CONTENT_AUDIO_BUCKET).download(row.audio_path);
    if (error || !file) return null;
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    return { base64, mimeType: row.audio_mime_type ?? 'audio/mpeg', voice: row.audio_voice ?? null, locale: row.audio_locale ?? null };
  } catch {
    return null;
  }
}

function buildResultFromRow(row: TrainingSessionRow): PronunciationNormalizedResult | undefined {
  if (row.status !== 'completed' || row.pronunciation_score === null) return undefined;
  return {
    pronunciationScore: row.pronunciation_score,
    accuracyScore: row.accuracy_score ?? 0,
    fluencyScore: row.fluency_score ?? 0,
    completenessScore: row.completeness_score ?? 0,
    prosodyScore: row.prosody_score,
    recognizedText: row.recognized_text ?? '',
    wordsJson: Array.isArray(row.words_json) ? row.words_json : [],
    rawSegments: Array.isArray(row.raw_result_json) ? row.raw_result_json : [],
    audioDurationSeconds: row.audio_duration_seconds ?? 0,
  };
}

function buildGenerateTextResponse(row: TrainingSessionRow) {
  const result = buildResultFromRow(row);
  return {
    sessionId: row.id,
    text: row.generated_text,
    level: row.level,
    status: row.status,
    ...(result ? { result } : {}),
  };
}

async function handleGenerateText(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const access = await requirePronunciationEnabled(userId);
  if (isAccessDenial(access)) return jsonError(res, access.status, access.code, access.message);
  const { entitlements } = access;
  if (!await applyRateLimit(res, userId, 'pronunciation-training-generate-text')) return;

  const practiceDate = getTodaySP();
  // `forceNew` is the user's "Gerar outro texto" intent (start a new round). The
  // effective daily limit is the plan capability, resolved server-side — a new
  // round is authorized purely by the dynamic count vs. that limit below, never
  // by the request body. Any plan (not only unlimited) can start another round
  // while under its configured N.
  const forceNew = Boolean((req.body ?? {}).forceNew);
  const evals = entitlements.pronunciation.evaluations;
  const dailyLimit = evals.limit;
  const dailyUnlimited = evals.unlimited;

  // At most ONE active (non-completed) row per user/day exists (partial unique
  // index uq_pts_active_per_day); completed rounds accumulate. Fetch the active
  // row (if any) and count today's completed rounds — the real per-day counter.
  const [activeRes, completedRes] = await Promise.all([
    supabase
      .from('pronunciation_training_sessions')
      .select('id, level, generated_text, status, pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score, recognized_text, words_json, raw_result_json, audio_duration_seconds, shared_content_item_id')
      .eq('user_id', userId).eq('practice_date', practiceDate).neq('status', 'completed')
      .maybeSingle(),
    supabase
      .from('pronunciation_training_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('practice_date', practiceDate).eq('status', 'completed'),
  ]);
  if (activeRes.error || completedRes.error) {
    safeLog('pronunciation-training/generate-text', 'existing_lookup_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar o texto de hoje. Tente novamente.');
  }
  const activeRow = activeRes.data as TrainingSessionRow | null;
  const dailyCompleted = completedRes.count ?? 0;
  const dailyMeta = { dailyCompleted, dailyLimit, dailyUnlimited };

  // A pending round (text not yet analyzed, in progress, or a retryable
  // failure): reloading always returns it — never generates a new text while a
  // round is pending. Preserves the "reload returns the same in-progress text".
  if (activeRow) {
    // Reentry the same day: return the SAME text (no generation) AND the persisted
    // reference audio, so reopening never re-calls OpenAI or Azure.
    const audio = await loadSharedReferenceAudio(getCurriculumServiceClient(), activeRow.shared_content_item_id);
    safeLog('pronunciation-training/generate-text', 'returned_active', 200);
    return res.status(200).json({ ...buildGenerateTextResponse(activeRow), ...dailyMeta, ...(audio ? { audio } : {}) });
  }

  // No active row. If the user already finished at least one round today and is
  // NOT explicitly starting a new one, return the latest completed round (the
  // "concluído" state) with no generation — preserves reload-after-finishing.
  if (dailyCompleted > 0 && !forceNew) {
    const { data: latestCompleted, error: latestErr } = await supabase
      .from('pronunciation_training_sessions')
      .select('id, level, generated_text, status, pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score, recognized_text, words_json, raw_result_json, audio_duration_seconds, shared_content_item_id')
      .eq('user_id', userId).eq('practice_date', practiceDate).eq('status', 'completed')
      .order('completed_at', { ascending: false }).limit(1).maybeSingle();
    if (latestErr || !latestCompleted) {
      safeLog('pronunciation-training/generate-text', 'latest_completed_lookup_error', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar o texto de hoje. Tente novamente.');
    }
    const audio = await loadSharedReferenceAudio(getCurriculumServiceClient(), (latestCompleted as TrainingSessionRow).shared_content_item_id);
    safeLog('pronunciation-training/generate-text', 'returned_completed', 200);
    return res.status(200).json({ ...buildGenerateTextResponse(latestCompleted as TrainingSessionRow), ...dailyMeta, ...(audio ? { audio } : {}) });
  }

  // Need to create a new round (first text of the day, or an explicit new
  // round). Dynamic quota gate — the effective limit is the plan capability,
  // never a hardcoded number; unlimited plans are never blocked. (Also covers a
  // 0/day or disabled plan, subsuming the old enabled-and->=1 pre-check.)
  if (!dailyUnlimited && dailyCompleted >= dailyLimit) {
    safeLog('pronunciation-training/generate-text', 'daily_limit_reached', 403);
    return jsonError(res, 403, 'DAILY_LIMIT_REACHED', ENTITLEMENT_MESSAGES.pronunciationTrainingDailyEvaluationCompleted, dailyMeta);
  }

  // Level is the CURRICULUM PATH's current level (per learning language), NOT a
  // global english_learning_memory level, and NEVER an invented 'A2' fallback
  // (blocker 8). A misconfigured curriculum is an explicit operational error.
  let userLevel: string | null = null;
  try {
    const ensured = await ensureUserCurriculum(getCurriculumServiceClient(), userId);
    userLevel = ensured.currentLevelCode;
  } catch (err) {
    if (err instanceof CurriculumConfigError) {
      safeLog('pronunciation-training/generate-text', 'curriculum_not_configured', 503);
      return jsonError(res, 503, 'CURRICULUM_NOT_CONFIGURED', 'O conteúdo do currículo ainda não está disponível. Tente novamente mais tarde.');
    }
    throw err;
  }
  if (!userLevel) {
    safeLog('pronunciation-training/generate-text', 'no_curriculum_level', 503);
    return jsonError(res, 503, 'CURRICULUM_NOT_CONFIGURED', 'O conteúdo do currículo ainda não está disponível. Tente novamente mais tarde.');
  }

  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'Serviço de IA não configurado.');

  // Data-driven curriculum: the pedagogy (system/user prompt, model, temperature)
  // is composed for the user's CURRENT recorte from the seeded
  // `pronunciation.generate_text` template — no hardcoded level-only English
  // pedagogy. A misconfigured curriculum is an explicit operational error, never
  // a silent English fallback.
  let resolvedPrompt;
  try {
    resolvedPrompt = await resolveActivityPrompt(getCurriculumServiceClient(), userId, {
      templateKey: 'pronunciation.generate_text',
      activityType: 'pronunciation',
    });
  } catch (err) {
    if (err instanceof CurriculumConfigError) {
      safeLog('pronunciation-training/generate-text', 'curriculum_not_configured', 503);
      return jsonError(res, 503, 'CURRICULUM_NOT_CONFIGURED', 'O conteúdo do currículo ainda não está disponível. Tente novamente mais tarde.');
    }
    throw err;
  }

  const systemPrompt = resolvedPrompt.system;
  // user_body is OPTIONAL: when the template has none, send only the system
  // message — never invent a fixed-language trigger like "Write the text now."
  // (blocker 8). All pedagogy lives in the system prompt.
  const userPrompt = resolvedPrompt.user ?? '';
  const chatMessages = userPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: userPrompt }]
    : [{ role: 'system' as const, content: systemPrompt }];
  const model = resolvedPrompt.model ?? AI_MODEL;
  const temperature = resolvedPrompt.temperature ?? 0.9;

  const openai = new OpenAI({ apiKey, timeout: GENERATE_TIMEOUT_MS });
  const gatewayDeps = getProductionDeps();
  const serviceClient = getCurriculumServiceClient();
  const learningLanguage = resolvedPrompt.languageContext.learningLanguage;
  const interfaceLanguage = resolvedPrompt.languageContext.interfaceLanguage;

  // Reference-TTS spec (best-effort): the shared library persists+reuses a model
  // pronunciation audio alongside the text. Missing/invalid Speech config simply
  // means no reference audio (the client can still fall back to /api/tts) — it
  // never blocks text generation/reuse (§9). Voice/locale are data-driven from
  // public.languages (no en-US hardcode).
  let audioSpec: SharedContentAudioSpec<{ text: string }> | undefined;
  try {
    const speech = await getLanguageSpeechConfig(serviceClient, learningLanguage);
    const productConfig = await getProductConfig(resolveConfigEnvironment());
    const outputFormat = productConfig.values['audio.azure'].outputFormat;
    if (SAFE_AZURE_VOICE_RE.test(speech.defaultTtsVoice)) {
      audioSpec = {
        extractText: (c) => c.text,
        voice: speech.defaultTtsVoice,
        locale: speech.speechLocale,
        synth: (text) => synthesizeSpeech({
          text, voice: speech.defaultTtsVoice, locale: speech.speechLocale,
          outputFormat, userId, endpoint: 'pronunciation-training/generate-text',
        }),
      };
    }
  } catch {
    audioSpec = undefined; // no reference audio; text still shared/generated normally
  }

  try {
    // Shared content library: reuse a compatible pronunciation text (+ reference
    // TTS) the user hasn't seen, or generate ONE now. OpenAI is called ONLY on a
    // cache miss (inside generateContent); Azure TTS only when producing/repairing
    // the reference audio. Keyed by curricular identity + prompt version — never
    // English-specific. The per-user daily session below still owns the quota.
    const shared = await getOrCreateSharedContent<{ text: string }>({
      client: serviceClient,
      userId,
      identity: {
        modality: 'pronunciation',
        learningLanguage,
        interfaceLanguage,
        curriculumVersionId: resolvedPrompt.versionId,
        subtopicKey: resolvedPrompt.subtopicKey ?? '',
        levelCode: userLevel ?? levelCodeFromSubtopicKey(resolvedPrompt.subtopicKey ?? ''),
        exerciseType: 'training',
        templateKey: 'pronunciation.generate_text',
        promptVersion: resolvedPrompt.templateVersion,
      },
      generatorModel: model,
      generateContent: async () => {
        const completion = await executeAiGatewayCall<ChatCompletion>(
          {
            featureKey: 'pronunciation.generate_text',
            provider: 'openai',
            service: 'chat.completions',
            model,
            userId,
            initiatedByUserId: userId,
            actorType: 'user',
            executionLocation: 'backend',
            correlationId: gatewayDeps.uuidGen(),
            attemptNumber: 1,
            callSequence: 1,
            technicalMetadata: {
              endpoint: 'pronunciation-training/generate-text',
              flowType: 'generate_text',
            },
            estimatedMetrics: estimateTextTokens(systemPrompt.length + userPrompt.length, 400),
          },
          () => openai.chat.completions.create({
            model,
            messages: chatMessages,
            temperature,
            max_tokens: 400,
          }),
          gatewayDeps,
          extractGenerateTextMetrics,
        );
        const generated = completion.choices[0]?.message?.content?.trim() ?? '';
        if (!generated) throw new SharedPronunciationTextEmptyError();
        return { text: generated };
      },
      audio: audioSpec,
    });
    const text = shared.content.text;

    // Atomic get-or-create of the PER-USER day session (owns the daily quota and
    // assessment isolation): if a concurrent request already created today's row
    // first, this returns THAT row and discards the text here — never two sessions
    // for the same user+day. The curricular identity (version + recorte) is
    // persisted IN THE SAME atomic operation (ROOT-1). Cache hit or miss, this
    // still runs — a cached activity counts against the quota exactly like a
    // freshly generated one.
    // Service-role client + explicit p_user_id: the daily limit is resolved
    // server-side (dailyLimit/dailyUnlimited from entitlements) and the RPC is
    // service_role-only, so a client can never call it directly with an inflated
    // or unlimited quota (security: quota RPC hardening).
    const { data: created, error: createError } = await getCurriculumServiceClient().rpc('create_pronunciation_training_text', {
      p_user_id: userId,
      p_practice_date: practiceDate, p_level: userLevel, p_generated_text: text,
      p_start_new_round: forceNew, p_effective_limit: dailyLimit, p_unlimited: dailyUnlimited,
      p_curriculum_version_id: resolvedPrompt.versionId,
      p_curriculum_subtopic_key: resolvedPrompt.subtopicKey,
    });
    if (createError) {
      // Critical write: the `{ error }` returned by Supabase is checked
      // explicitly (never relied on a catch alone) — a persistence failure
      // NEVER delivers a curricular session.
      safeLog('pronunciation-training/generate-text', 'persist_rpc_error', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível salvar o texto gerado. Tente novamente.');
    }
    const result = (created ?? {}) as Record<string, unknown>;
    if (result.error) {
      // A concurrent request may have reached the limit between our pre-check
      // and this call — the RPC re-checks atomically and is authoritative.
      if (result.error === 'DAILY_LIMIT_REACHED') {
        safeLog('pronunciation-training/generate-text', 'daily_limit_reached_rpc', 403);
        return jsonError(res, 403, 'DAILY_LIMIT_REACHED', ENTITLEMENT_MESSAGES.pronunciationTrainingDailyEvaluationCompleted, {
          dailyCompleted: (result.dailyCompleted as number) ?? dailyCompleted, dailyLimit, dailyUnlimited,
        });
      }
      safeLog('pronunciation-training/generate-text', 'persist_rejected', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível salvar o texto gerado. Tente novamente.');
    }

    // Best-effort traceability: link this day's session to the library item it
    // was served from (never affects behaviour; user_shared_content_usage is the
    // authoritative repetition ledger). Fully defensive — a link failure must
    // never break the response.
    if (typeof result.sessionId === 'string') {
      try {
        await serviceClient
          .from('pronunciation_training_sessions')
          .update({ shared_content_item_id: shared.itemId })
          .eq('id', result.sessionId)
          .then(() => {}, () => {});
      } catch { /* traceability only */ }
    }

    safeLog('pronunciation-training/generate-text', shared.reused ? 'success_cache_hit' : 'success', 200);
    return res.status(200).json({
      sessionId: result.sessionId,
      text: result.text,
      level: result.level,
      status: result.status,
      dailyCompleted: (result.dailyCompleted as number) ?? dailyCompleted,
      dailyLimit,
      dailyUnlimited,
      // Additive: the reused/generated reference TTS audio for the text, when
      // available. `voice` lets the client reuse it only when it matches the
      // user's current voice, otherwise falling back to /api/tts. Absent when TTS
      // is unavailable — the client then falls back to /api/tts (no behaviour change).
      ...(shared.audio ? { audio: { base64: shared.audio.base64, mimeType: shared.audio.mimeType, voice: shared.audio.voice, locale: shared.audio.locale } } : {}),
      ...(result.result ? { result: result.result } : {}),
    });
  } catch (err) {
    if (err instanceof SharedPronunciationTextEmptyError) {
      return jsonError(res, 503, 'AI_UNAVAILABLE', 'Não foi possível gerar o texto. Tente novamente.');
    }
    const { code, status } = sanitizeProviderError(err);
    return jsonError(res, status, code, 'Não foi possível gerar o texto. Tente novamente.');
  }
}

// ─── POST /api/pronunciation-training/token ───────────────────────────────────

const AZURE_ERROR_STATUS: Partial<Record<string, number>> = {
  AZURE_SPEECH_NOT_CONFIGURED: 503, AZURE_SPEECH_AUTH_FAILED: 503,
  AZURE_SPEECH_TIMEOUT: 504, AZURE_SPEECH_RATE_LIMITED: 503, AZURE_SPEECH_UNAVAILABLE: 503,
};

function extractTokenMetrics(): GatewayUsageMetric[] {
  return [
    {
      metricKey: 'provider_requests',
      unitType: 'request',
      quantity: 1,
      isBillable: false,
      measurementSource: 'provider_response',
    },
  ];
}

// Longest single word we will ever count/train — generous vs. any real
// English word, but bounds the DB key and rejects junk from a direct caller.
const MAX_WORD_PRACTICE_WORD_LENGTH = 80;

const WORD_ATTEMPT_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  INVALID_OWNER_TYPE: 400,
  INVALID_WORD: 400,
  OWNER_NOT_FOUND: 404,
  WORD_ATTEMPT_LIMIT_REACHED: 429,
};

/**
 * Refunds the single attempt that register_word_practice_attempt just
 * consumed, used ONLY when the server itself failed to deliver the Azure
 * token (so no client-side evaluation could ever happen). Refund is
 * server-decided and therefore un-bypassable — it is never triggered by a
 * client-reported failure (SDK/conversion/network-after-token/modal close),
 * which would reopen the register→release→register bypass.
 *
 * Called through the service-role client because release_word_practice_attempt
 * is granted to service_role only (never to the client, for the same reason).
 * Best-effort: a refund failure is logged and never masks the original
 * token-issuance error the caller is about to surface. Scoped to the exact
 * (user, ownerType, ownerId, word) row and floored at zero in SQL, so it can
 * never go negative nor touch a concurrent valid attempt.
 */
async function refundWordPracticeAttempt(
  userId: string,
  ownerType: WordPracticeOwnerType,
  ownerId: string,
  word: string,
): Promise<void> {
  try {
    const supabase = getSharedServiceClient();
    await supabase.rpc('release_word_practice_attempt', {
      p_user_id: userId,
      p_owner_type: ownerType,
      p_owner_id: ownerId,
      p_word: word,
    });
  } catch {
    safeLog('pronunciation-training/token', 'word_attempt_refund_failed', 500);
  }
}

/**
 * This endpoint serves ONLY the individual-word training drill (both
 * surfaces: WordRow and PracticeWordRow — the full-text flows use /start,
 * which mints its own token). Every call is therefore one word-practice
 * attempt, and the per-word 3-attempt limit is enforced HERE, server-side,
 * BEFORE any Azure credential is minted — so a direct API call cannot exceed
 * it. The count is anchored to a server-owned row (ownerId) whose ownership
 * is re-verified inside register_word_practice_attempt, never trusted from
 * the request. The 5s cap is fixed and returned as maxDurationSeconds so the
 * recorder's auto-stop uses a server-authoritative value.
 */
async function handleToken(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const tokenAccess = await requirePronunciationEnabled(auth.userId);
  if (isAccessDenial(tokenAccess)) return jsonError(res, tokenAccess.status, tokenAccess.code, tokenAccess.message);
  if (!await applyRateLimit(res, auth.userId, 'pronunciation-training-token')) return;

  // ── Per-word attempt gate (individual-word drill) ──────────────────────────
  const { word, ownerType, ownerId } = (req.body ?? {}) as {
    word?: unknown; ownerType?: unknown; ownerId?: unknown;
  };
  if (typeof word !== 'string' || word.trim() === '' || word.length > MAX_WORD_PRACTICE_WORD_LENGTH) {
    return jsonError(res, 400, 'INVALID_WORD', 'Palavra inválida para o treino individual.');
  }
  if (!isWordPracticeOwnerType(ownerType)) {
    return jsonError(res, 400, 'INVALID_OWNER_TYPE', 'Contexto de treino inválido.');
  }
  if (typeof ownerId !== 'string' || !isValidUuid(ownerId)) {
    return jsonError(res, 400, 'INVALID_OWNER_ID', 'Identificador de contexto inválido.');
  }

  // Resolve the recognition locale (data-driven, from the learning language)
  // BEFORE registering a word-practice attempt (blocker 4A): a missing Speech
  // config must never burn one of the user's 3 attempts. Explicit error, no
  // en-US fallback, zero side effects.
  let recognitionLocale: string;
  try {
    recognitionLocale = (await resolveUserSpeechConfig(getCurriculumServiceClient(), auth.userId)).speechLocale;
  } catch (err) {
    if (err instanceof SpeechConfigError) {
      safeLog('pronunciation-training/token', 'speech_config_missing', 503);
      return jsonError(res, 503, 'PRONUNCIATION_UNAVAILABLE', 'Serviço de pronúncia temporariamente indisponível. Tente novamente.');
    }
    throw err;
  }

  const { data: attemptData, error: attemptError } = await auth.supabase.rpc('register_word_practice_attempt', {
    p_owner_type: ownerType,
    p_owner_id: ownerId,
    p_word: word,
    p_max_attempts: WORD_PRACTICE_MAX_ATTEMPTS,
  });
  if (attemptError) {
    safeLog('pronunciation-training/token', 'word_attempt_rpc_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao registrar a tentativa.');
  }
  const attempt = (attemptData ?? {}) as { error?: string; attemptsUsed?: number };
  if (attempt.error) {
    const status = WORD_ATTEMPT_ERROR_STATUS[attempt.error] ?? 500;
    if (attempt.error === 'WORD_ATTEMPT_LIMIT_REACHED') {
      return res.status(status).json({
        code: 'WORD_ATTEMPT_LIMIT_REACHED',
        message: `Você já usou as ${WORD_PRACTICE_MAX_ATTEMPTS} tentativas desta palavra.`,
        attemptsUsed: attempt.attemptsUsed ?? WORD_PRACTICE_MAX_ATTEMPTS,
        maxAttempts: WORD_PRACTICE_MAX_ATTEMPTS,
      });
    }
    if (attempt.error === 'OWNER_NOT_FOUND') {
      return jsonError(res, status, 'OWNER_NOT_FOUND', 'Contexto de treino não encontrado.');
    }
    return jsonError(res, status, attempt.error, 'Não foi possível registrar a tentativa.');
  }
  const attemptsUsed = typeof attempt.attemptsUsed === 'number' ? attempt.attemptsUsed : 1;

  const gatewayDeps = getProductionDeps();
  try {
    const { token, region, expiresInSeconds } = await executeAiGatewayCall(
      {
        featureKey: 'pronunciation.get_azure_token',
        provider: 'azure',
        service: 'speech_sts',
        userId: auth.userId,
        initiatedByUserId: auth.userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'pronunciation-training/token',
        },
      },
      () => issueAzureSpeechToken(),
      gatewayDeps,
      extractTokenMetrics,
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      token,
      region,
      language: recognitionLocale,
      expiresInSeconds,
      attemptsUsed,
      maxAttempts: WORD_PRACTICE_MAX_ATTEMPTS,
      maxDurationSeconds: WORD_PRACTICE_MAX_DURATION_SECONDS,
    });
  } catch (err) {
    // The attempt was already registered above, but the server never delivered
    // a token (Azure 401/5xx/timeout, or any internal error before returning
    // it) — refund that attempt before surfacing the original error. Reachable
    // only after a successful register: the limit/owner-not-found paths return
    // earlier, before any increment, so this never over-refunds.
    await refundWordPracticeAttempt(auth.userId, ownerType, ownerId, word);
    if (err instanceof AzureSpeechError) {
      const status = AZURE_ERROR_STATUS[err.code] ?? 503;
      return jsonError(res, status, err.code, 'Serviço de pronúncia temporariamente indisponível. Tente novamente.');
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno. Tente novamente.');
  }
}

// ─── POST /api/pronunciation-training/start ───────────────────────────────────
// Reserves the day's single official submission slot — atomic, idempotent
// per attemptId, and terminal once completed (see
// reserve_pronunciation_training_assessment in the migration; unlike the
// writing flow's reserve_pronunciation_assessment, a 'completed' status here
// never restarts). Reuses the same Azure token issuance and Gateway
// wrapping as api/pronunciation/[...slug].ts's handleStart, and the same
// featureKey ('pronunciation.start_assessment') — this is still, at the AI
// Gateway's level, a pronunciation assessment start; the day-scoped
// reservation table is the only thing distinguishing the two surfaces.

const TRAINING_RESERVE_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  INVALID_ATTEMPT_ID: 400,
  TEXT_NOT_GENERATED: 409,
  ASSESSMENT_IN_PROGRESS: 409,
  DAILY_LIMIT_REACHED: 403,
  ASSESSMENT_UNAVAILABLE: 500,
};

async function handleTrainingStart(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const access = await requirePronunciationEnabled(userId);
  if (isAccessDenial(access)) return jsonError(res, access.status, access.code, access.message);
  const { entitlements } = access;
  if (!dailyPronunciationTrainingAllowedByPlan(entitlements)) {
    return jsonError(res, 403, 'DAILY_LIMIT_REACHED', ENTITLEMENT_MESSAGES.pronunciationTrainingDailyEvaluationCompleted);
  }

  const { attemptId } = req.body ?? {};
  if (!isValidUuid(attemptId)) {
    return jsonError(res, 400, 'INVALID_ATTEMPT_ID', 'O identificador de tentativa é inválido.');
  }

  const azureRegion = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!azureRegion) {
    return jsonError(res, 503, 'AZURE_SPEECH_NOT_CONFIGURED', 'O serviço de pronúncia ainda não está configurado.');
  }

  if (!await applyRateLimit(res, userId, 'pronunciation-training-start')) return;

  // Resolve the recognition locale BEFORE reserving the assessment or minting an
  // Azure token (blocker 4B): a missing Speech config must never leave a
  // reservation stuck. Explicit error, no en-US fallback, zero side effects.
  let startLocale: string;
  try {
    startLocale = (await resolveUserSpeechConfig(getCurriculumServiceClient(), userId)).speechLocale;
  } catch (err) {
    if (err instanceof SpeechConfigError) {
      safeLog('pronunciation-training/start', 'speech_config_missing', 503);
      return jsonError(res, 503, 'PRONUNCIATION_UNAVAILABLE', 'Serviço de pronúncia temporariamente indisponível. Tente novamente.');
    }
    throw err;
  }

  const practiceDate = getTodaySP();
  // The effective daily limit + unlimited flag come from the already-resolved
  // plan entitlement; the RPC enforces N atomically (no number hardcoded in SQL
  // or here). Unlimited plans pass null-limit and are never blocked by count.
  // Service-role client + explicit p_user_id: the daily limit is resolved
  // server-side (entitlements) and the RPC is service_role-only, closing the
  // direct-call bypass where a client set p_unlimited=true to mint unlimited
  // Azure assessment tokens (security: quota RPC hardening).
  const { data: reserveData, error: rpcError } = await getCurriculumServiceClient().rpc('reserve_pronunciation_training_assessment', {
    p_user_id: userId,
    p_practice_date: practiceDate, p_azure_region: azureRegion, p_attempt_id: attemptId,
    p_effective_limit: entitlements.pronunciation.evaluations.limit,
    p_unlimited: entitlements.pronunciation.evaluations.unlimited,
  });
  if (rpcError) {
    safeLog('pronunciation-training/start', 'reserve_rpc_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao reservar a avaliação.');
  }
  const reserved = (reserveData ?? {}) as { error?: string; sessionId?: string; referenceText?: string; dailyCompleted?: number };
  if (reserved.error) {
    const status = TRAINING_RESERVE_ERROR_STATUS[reserved.error] ?? 500;
    const message = reserved.error === 'DAILY_LIMIT_REACHED'
      ? ENTITLEMENT_MESSAGES.pronunciationTrainingDailyEvaluationCompleted
      : reserved.error === 'ASSESSMENT_IN_PROGRESS'
        ? 'Já existe uma análise em andamento para o texto de hoje.'
        : reserved.error === 'TEXT_NOT_GENERATED'
          ? 'Gere o texto de treino antes de solicitar a análise.'
          : 'Erro interno ao reservar a avaliação.';
    return jsonError(res, status, reserved.error, message, reserved.sessionId ? { sessionId: reserved.sessionId } : undefined);
  }
  const sessionId = reserved.sessionId as string;
  const referenceText = reserved.referenceText as string;

  const gatewayDeps = getProductionDeps();
  let tokenResult: Awaited<ReturnType<typeof issueAzureSpeechToken>>;
  try {
    tokenResult = await executeAiGatewayCall(
      {
        featureKey: 'pronunciation.start_assessment',
        provider: 'azure',
        service: 'speech_sts',
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'pronunciation_training_session',
        resourceId: sessionId,
        technicalMetadata: { endpoint: 'pronunciation-training/start' },
      },
      () => issueAzureSpeechToken(),
      gatewayDeps,
      extractTokenMetrics,
    );
  } catch (err) {
    try {
      const errorCode = err instanceof AzureSpeechError ? err.code : 'TOKEN_ISSUE_FAILED';
      await supabase.rpc('compensate_pronunciation_training_assessment', {
        p_session_id: sessionId, p_error_code: errorCode, p_error_message: 'Falha ao emitir credencial temporária de pronúncia.',
      });
    } catch { /* best-effort compensation — the reservation still needs releasing, but never masks the original error */ }
    if (err instanceof AzureSpeechError) {
      const status = AZURE_ERROR_STATUS[err.code] ?? 503;
      return jsonError(res, status, err.code, 'Serviço de pronúncia temporariamente indisponível. Tente novamente.');
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao preparar a análise.');
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    sessionId, attemptId, token: tokenResult.token, region: tokenResult.region,
    language: startLocale, referenceText,
    dailyCompleted: reserved.dailyCompleted,
    dailyLimit: entitlements.pronunciation.evaluations.limit,
    dailyUnlimited: entitlements.pronunciation.evaluations.unlimited,
  });
}

// ─── POST /api/pronunciation-training/complete ────────────────────────────────

const MAX_BODY_BYTES_TRAINING_COMPLETE = 2 * 1024 * 1024;

function isFiniteTrainingScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}
function validateTrainingResult(r: unknown): r is PronunciationNormalizedResult {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (!isFiniteTrainingScore(o.pronunciationScore)) return false;
  if (!isFiniteTrainingScore(o.accuracyScore)) return false;
  if (!isFiniteTrainingScore(o.fluencyScore)) return false;
  if (!isFiniteTrainingScore(o.completenessScore)) return false;
  if (o.prosodyScore !== null && !isFiniteTrainingScore(o.prosodyScore)) return false;
  if (typeof o.recognizedText !== 'string' || o.recognizedText.length > 50_000) return false;
  if (!Array.isArray(o.wordsJson) || o.wordsJson.length > 5_000) return false;
  if (!Array.isArray(o.rawSegments) || o.rawSegments.length > 1_000) return false;
  if (typeof o.audioDurationSeconds !== 'number' || !Number.isFinite(o.audioDurationSeconds)) return false;
  return true;
}

async function handleTrainingComplete(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES_TRAINING_COMPLETE) {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload muito grande.');
  }
  const raw = req.body ?? {};
  const { sessionId, attemptId, result } = raw;
  if (!isValidUuid(sessionId)) return jsonError(res, 400, 'INVALID_SESSION_ID', 'sessionId inválido.');
  if (!isValidUuid(attemptId)) return jsonError(res, 400, 'INVALID_ATTEMPT_ID', 'attemptId inválido.');
  if (!validateTrainingResult(result)) return jsonError(res, 400, 'INVALID_RESULT', 'Resultado inválido ou fora do intervalo permitido.');

  const access = await requirePronunciationEnabled(userId);
  if (isAccessDenial(access)) return jsonError(res, access.status, access.code, access.message);

  return finalizeTrainingAssessment(res, supabase, userId, access.entitlements, sessionId, attemptId, result);
}

/**
 * Persists a finished assessment and returns the canonical response.
 *
 * Shared by /complete (result produced by an older browser client) and /assess
 * (result produced server-side). Keeping ONE implementation is what guarantees
 * the quota and idempotency rules stay identical on both paths: the daily slot
 * is consumed by /start, `dailyCompleted` only advances here, a duplicate
 * attempt still returns 409 ASSESSMENT_ALREADY_COMPLETED, and curricular credit
 * stays convergent + idempotent.
 */
async function finalizeTrainingAssessment(
  res: any,
  supabase: any,
  userId: string,
  entitlements: any,
  sessionId: string,
  attemptId: string,
  result: PronunciationNormalizedResult,
) {
  // Server-side re-validation of the plan's recording-duration cap — the
  // client-side auto-stop (useAudioRecorder's maxDurationMs) is UX only,
  // this is the definitive check, exactly mirroring
  // api/pronunciation/[...slug].ts's handleComplete. A rejected duration
  // releases the reservation (RESULT_INVALID) instead of leaving the
  // session stuck in 'processing', so the user can retry the same day.
  const durationCheck = checkRecordingDuration(
    result.audioDurationSeconds, entitlements.pronunciation.maxRecordingSeconds, entitlements.pronunciation.maxRecordingUnlimited,
  );
  if (!durationCheck.allowed) {
    try {
      await supabase.rpc('fail_pronunciation_training_assessment', { p_session_id: sessionId, p_attempt_id: attemptId, p_error_code: 'RESULT_INVALID' });
    } catch { /* best-effort slot release */ }
    return jsonError(res, 413, durationCheck.code!, durationCheck.message!);
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc('complete_pronunciation_training_assessment', {
    p_session_id: sessionId, p_attempt_id: attemptId,
    p_pronunciation_score: result.pronunciationScore, p_accuracy_score: result.accuracyScore,
    p_fluency_score: result.fluencyScore, p_completeness_score: result.completenessScore,
    p_prosody_score: result.prosodyScore ?? null, p_recognized_text: result.recognizedText,
    p_words_json: result.wordsJson, p_raw_result_json: result.rawSegments,
    p_audio_duration_s: result.audioDurationSeconds,
  });
  if (rpcError) {
    safeLog('pronunciation-training/complete', 'rpc_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao salvar o resultado.');
  }
  const rpc = (rpcData ?? {}) as Record<string, unknown>;
  if (rpc.error === 'UNAUTHORIZED') return jsonError(res, 401, 'UNAUTHORIZED', 'Faça login para continuar.');
  if (rpc.error === 'NOT_FOUND') return jsonError(res, 404, 'NOT_FOUND', 'Avaliação não encontrada.');
  if (rpc.error === 'ASSESSMENT_ALREADY_COMPLETED') {
    // CONVERGENT credit (blocker 6.B): a retry after a first-attempt credit
    // failure still lands the credit, idempotently, WITHOUT re-running the
    // provider (the assessment was already saved). Then keep the 409 idempotency
    // signal the client already handles.
    try { await reconcilePronunciationCredit(userId, sessionId); } catch { safeLog('pronunciation-training/complete', 'credit_reconcile_failed', 200); }
    return jsonError(res, 409, 'ASSESSMENT_ALREADY_COMPLETED', 'O texto de hoje já possui uma análise concluída.');
  }
  if (rpc.error === 'ATTEMPT_MISMATCH') return jsonError(res, 409, 'ATTEMPT_MISMATCH', 'Esta tentativa não corresponde à tentativa ativa.');
  if (rpc.error) {
    safeLog('pronunciation-training/complete', 'rpc_unexpected', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao salvar o resultado.');
  }

  // Behavioral push attribution (association, not causality). Best-effort,
  // idempotent, isolated — never affects this response.
  void recordBehavioralPushActivityConversion(userId, 'pronunciation');

  // Data-driven curriculum: a successfully completed assessment is one valid
  // pronunciation practice — recorded against the recorte the session was
  // GENERATED for (blockers 5, 8, 10). Idempotent + convergent (blocker 6.B).
  // Best-effort — a recording failure must never affect the assessment response.
  try { await reconcilePronunciationCredit(userId, sessionId); } catch {
    safeLog('pronunciation-training/complete', 'record_curricular_practice_failed', 200);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    sessionId, status: 'completed', result,
    dailyCompleted: (rpc.dailyCompleted as number | undefined),
    dailyLimit: entitlements.pronunciation.evaluations.limit,
    dailyUnlimited: entitlements.pronunciation.evaluations.unlimited,
  });
}

// ─── POST /api/pronunciation-training/assess ──────────────────────────────────
//
// Server-side continuous pronunciation assessment. Replaces the browser-side
// Azure Speech WebSocket leg, which could stall with zero events (see the module
// header in api/_azure-pronunciation.ts). The client now uploads the WAV it
// already produces and this endpoint runs Azure, scores with the SAME shared
// module the browser used, and finalizes through finalizeTrainingAssessment —
// so scores, per-word/phoneme data, counters and idempotency are unchanged.

/** ~12 MB of base64 ≈ 9 MB of WAV ≈ 4.7 min of 16 kHz mono 16-bit audio. */
const MAX_BODY_BYTES_TRAINING_ASSESS = 12 * 1024 * 1024;

async function handleTrainingAssess(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES_TRAINING_ASSESS) {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'A gravação é grande demais para ser analisada.');
  }

  const { sessionId, attemptId, audioBase64 } = req.body ?? {};
  if (!isValidUuid(sessionId)) return jsonError(res, 400, 'INVALID_SESSION_ID', 'sessionId inválido.');
  if (!isValidUuid(attemptId)) return jsonError(res, 400, 'INVALID_ATTEMPT_ID', 'attemptId inválido.');
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    return jsonError(res, 400, 'INVALID_AUDIO', 'Áudio ausente.');
  }

  const access = await requirePronunciationEnabled(userId);
  if (isAccessDenial(access)) return jsonError(res, access.status, access.code, access.message);
  const { entitlements } = access;

  if (!await applyRateLimit(res, userId, 'pronunciation-training-start')) return;

  // Read back the reservation /start created. The reference text ALWAYS comes
  // from the DB row, never from the request — the client cannot choose what it
  // is graded against (same trust boundary /start already enforced).
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('pronunciation_training_sessions')
    .select('id, status, active_attempt_id, generated_text, language_code')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionErr) {
    safeLog('pronunciation-training/assess', 'session_read_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao carregar a análise.');
  }
  if (!sessionRow) return jsonError(res, 404, 'NOT_FOUND', 'Avaliação não encontrada.');
  if (sessionRow.status === 'completed') {
    return jsonError(res, 409, 'ASSESSMENT_ALREADY_COMPLETED', 'O texto de hoje já possui uma análise concluída.');
  }
  if (sessionRow.status !== 'processing' || sessionRow.active_attempt_id !== attemptId) {
    return jsonError(res, 409, 'ATTEMPT_MISMATCH', 'Esta tentativa não corresponde à tentativa ativa.');
  }

  let wav: Buffer;
  try {
    wav = Buffer.from(audioBase64, 'base64');
  } catch {
    return jsonError(res, 400, 'INVALID_AUDIO', 'Áudio inválido.');
  }

  /** Releases the reserved daily slot so a failure never consumes an analysis. */
  const releaseSlot = async (code: PronunciationFailCode) => {
    try {
      await supabase.rpc('fail_pronunciation_training_assessment', {
        p_session_id: sessionId, p_attempt_id: attemptId, p_error_code: code,
      });
    } catch { /* best-effort: the client's /fail cleanup is the backstop */ }
  };

  const gatewayDeps = getProductionDeps();
  let assessed: Awaited<ReturnType<typeof assessPronunciation>>;
  try {
    assessed = await executeAiGatewayCall(
      {
        featureKey: 'pronunciation.assess_text',
        provider: 'azure',
        service: 'speech_sdk',
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'pronunciation_training_session',
        resourceId: sessionId,
        technicalMetadata: { endpoint: 'pronunciation-training/assess' },
      },
      () => assessPronunciation({
        wav,
        referenceText: sessionRow.generated_text as string,
        language: (sessionRow.language_code as string | null) ?? undefined,
        logLabel: sessionId,
      }),
      gatewayDeps,
    );
  } catch (err) {
    const code: PronunciationFailCode =
      err instanceof PronunciationServiceError ? err.code : 'AZURE_CANCELED';
    await releaseSlot(code);
    safeLog('pronunciation-training/assess', `failed_${code.toLowerCase()}`, 502);

    const message =
      code === 'AZURE_NO_MATCH'
        ? 'Nenhuma fala foi detectada no áudio. Grave novamente e tente outra vez.'
        : code === 'AUDIO_EMPTY' || code === 'AUDIO_DECODE_FAILED'
          ? 'Não foi possível preparar esta gravação para análise. Grave novamente e tente outra vez.'
          : code === 'AZURE_TIMEOUT'
            ? 'O serviço de pronúncia demorou para responder. Tente novamente.'
            : 'Ocorreu um erro durante a análise. Tente novamente.';
    return jsonError(res, code === 'AUDIO_EMPTY' || code === 'AUDIO_DECODE_FAILED' ? 400 : 502, code, message);
  }

  return finalizeTrainingAssessment(
    res, supabase, userId, entitlements, sessionId, attemptId, assessed.result,
  );
}

// ─── POST /api/pronunciation-training/fail ────────────────────────────────────

const TRAINING_ALLOWED_FAIL_CODES = new Set<PronunciationFailCode>([
  'AUDIO_DECODE_FAILED', 'AUDIO_EMPTY', 'AZURE_NO_MATCH', 'AZURE_CANCELED', 'AZURE_AUTH_FAILED',
  'AZURE_TIMEOUT', 'AZURE_NETWORK_ERROR', 'RESULT_INVALID', 'CLIENT_INTERRUPTED',
]);

async function handleTrainingFail(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const { sessionId, attemptId, code } = req.body ?? {};
  if (!isValidUuid(sessionId)) return jsonError(res, 400, 'INVALID_SESSION_ID', 'sessionId inválido.');
  if (!isValidUuid(attemptId)) return jsonError(res, 400, 'INVALID_ATTEMPT_ID', 'attemptId inválido.');
  if (typeof code !== 'string' || !TRAINING_ALLOWED_FAIL_CODES.has(code as PronunciationFailCode)) {
    return jsonError(res, 400, 'INVALID_ERROR_CODE', 'Código de erro não permitido.');
  }
  const { data: rpcData, error: rpcError } = await supabase.rpc('fail_pronunciation_training_assessment', {
    p_session_id: sessionId, p_attempt_id: attemptId, p_error_code: code,
  });
  if (rpcError) {
    safeLog('pronunciation-training/fail', 'rpc_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
  const rpc = (rpcData ?? {}) as Record<string, unknown>;
  if (rpc.error === 'UNAUTHORIZED') return jsonError(res, 401, 'UNAUTHORIZED', 'Faça login para continuar.');
  if (rpc.error === 'NOT_FOUND') return jsonError(res, 404, 'NOT_FOUND', 'Avaliação não encontrada.');
  if (rpc.error) {
    safeLog('pronunciation-training/fail', 'rpc_unexpected', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }

  // Operational-alert coverage for the browser Azure SDK path (see the
  // pronunciation /fail handler). Only genuine Azure outages record + alert;
  // fully isolated from the response.
  const providerSignal = mapPronunciationFailCodeToProviderSignal(code);
  if (providerSignal) {
    try {
      await recordAndAlertBrowserProviderFailure({
        featureKey: 'pronunciation.assess_text',
        providerRaw: 'azure',
        httpStatus: providerSignal.httpStatus,
        errorCode: providerSignal.errorCode,
        service: 'speech_sdk',
        userId: auth.userId,
      });
    } catch { /* isolated — alerting must never affect /fail */ }
  }

  return res.status(200).json({ status: rpc.action ?? 'no_op' });
}

// ─── GET /api/pronunciation-training/plan-entitlements ─────────────────────────
// Unrelated to pronunciation training — nested here purely to stay under
// Vercel's 12-serverless-function Hobby-plan cap (was its own top-level
// api/plan-entitlements.ts, which pushed the count to 13). The authenticated
// user's resolved plan/entitlements snapshot; the plan is always resolved
// server-side from the authenticated user, never influenced by the request.

async function handlePlanEntitlements(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  if (!(await applyRateLimit(res, userId, 'plan-entitlements'))) return;
  // The resolved plan/entitlements snapshot must NEVER be served from a stale
  // HTTP cache — a plan change (e.g. an admin granting an unlimited plan) has to
  // take effect on the very next fetch. Without this, the app could keep showing
  // an older commercial snapshot even though the server resolves the new plan
  // correctly. Matches every sibling handler in this file (all set no-store).
  res.setHeader('Cache-Control', 'no-store');
  try {
    const snapshot = await getCurrentUserPlanEntitlements(userId);
    return res.json(snapshot);
  } catch (err) {
    safeLog('plan-entitlements', 'resolve_failed', 500, {
      errName: err instanceof Error ? err.name : typeof err,
      errMessage: err instanceof Error ? err.message : String(err),
    });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar as informações do seu plano.');
  }
}

// ─── POST /api/pronunciation-training/evaluate ─────────────────────────────────
// Unrelated to pronunciation training — nested here for the same reason as
// handlePlanEntitlements above (Vercel Hobby-plan 12-function cap; this
// deployment was back at 13 after api/conversation/[...slug].ts and
// api/internal/conversation/[...slug].ts's Etapa 11 additions, confirmed by
// a real production deployment failure — errorCode
// exceeded_serverless_functions_per_deployment). Was its own top-level
// api/promotion/evaluate.ts; moved verbatim (no behavior change). No caller
// of the old path existed anywhere in this repo at move time (confirmed by
// a full-repo search) — skill promotion is evaluated by
// evaluateSkillPromotion() directly from other server-side call sites, not
// over HTTP, so this route currently has no known caller either; kept
// available (not deleted) since removing a public API surface is a
// separate, unrelated decision from a function-count fix.

const VALID_PROMOTION_SKILLS = ['writing', 'pronunciation', 'conversation'] as const;
type ValidPromotionSkill = typeof VALID_PROMOTION_SKILLS[number];

function isValidPromotionSkill(s: unknown): s is ValidPromotionSkill {
  return typeof s === 'string' && (VALID_PROMOTION_SKILLS as readonly string[]).includes(s);
}

function isValidPromotionTrigger(t: unknown): t is PromotionTrigger {
  const valid = [
    'mission_completed', 'checkpoint_completed', 'evidence_processed',
    'topic_mastered', 'session_ended', 'admin_recalculate', 'job', 'retry',
  ];
  return typeof t === 'string' && valid.includes(t);
}

async function handlePromotionEvaluate(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { userId } = auth;
  const body = req.body ?? {};

  const { skill, trigger, idempotencyKey } = body as {
    skill?: unknown;
    trigger?: unknown;
    idempotencyKey?: unknown;
  };

  if (!isValidPromotionSkill(skill)) {
    jsonError(res, 400, 'INVALID_REQUEST', 'skill deve ser writing, pronunciation ou conversation.');
    return;
  }

  const resolvedTrigger: PromotionTrigger =
    isValidPromotionTrigger(trigger) ? trigger : 'mission_completed';

  const resolvedKey: string =
    typeof idempotencyKey === 'string' && idempotencyKey.length > 0
      ? idempotencyKey
      : crypto.randomUUID();

  try {
    const evaluation = await evaluateSkillPromotion({
      userId,
      skill,
      trigger: resolvedTrigger,
      idempotencyKey: resolvedKey,
    });

    res.status(200).json({ evaluation });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro interno ao avaliar promoção.';
    jsonError(res, 500, 'INTERNAL_ERROR', message);
  }
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

// ─── POST /api/pronunciation-training/word-assess ─────────────────────────────
//
// Server-side per-word assessment for the individual-word drill (BOTH surfaces:
// the standalone WordRow and the writing-flow PracticeWordRow). Replaces the
// browser→Azure WebSocket leg (fetchWordPracticeToken + createRecognitionSession)
// that could stall with zero SDK events and only surfaced as "Análise demorou".
// Registers the attempt server-side (same 3/word cap, BEFORE any provider work),
// then runs Azure over the uploaded WAV with the WORD as reference text. Refunds
// the attempt on a provider failure so a failed analysis is never consumed.

const MAX_BODY_BYTES_WORD_ASSESS = 4 * 1024 * 1024; // one short word ≈ ≤5s audio

async function handleWordAssess(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const access = await requirePronunciationEnabled(auth.userId);
  if (isAccessDenial(access)) return jsonError(res, access.status, access.code, access.message);
  if (!await applyRateLimit(res, auth.userId, 'pronunciation-training-token')) return;

  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES_WORD_ASSESS) {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'A gravação é grande demais para ser analisada.');
  }

  const { word, ownerType, ownerId, audioBase64 } = (req.body ?? {}) as {
    word?: unknown; ownerType?: unknown; ownerId?: unknown; audioBase64?: unknown;
  };
  if (typeof word !== 'string' || word.trim() === '' || word.length > MAX_WORD_PRACTICE_WORD_LENGTH) {
    return jsonError(res, 400, 'INVALID_WORD', 'Palavra inválida para o treino individual.');
  }
  if (!isWordPracticeOwnerType(ownerType)) {
    return jsonError(res, 400, 'INVALID_OWNER_TYPE', 'Contexto de treino inválido.');
  }
  if (typeof ownerId !== 'string' || !isValidUuid(ownerId)) {
    return jsonError(res, 400, 'INVALID_OWNER_ID', 'Identificador de contexto inválido.');
  }
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    return jsonError(res, 400, 'INVALID_AUDIO', 'Áudio ausente.');
  }

  // Recognition locale BEFORE registering the attempt (a missing Speech config
  // must never burn one of the 3 attempts) — same order as /token.
  let recognitionLocale: string;
  try {
    recognitionLocale = (await resolveUserSpeechConfig(getCurriculumServiceClient(), auth.userId)).speechLocale;
  } catch (err) {
    if (err instanceof SpeechConfigError) {
      safeLog('pronunciation-training/word-assess', 'speech_config_missing', 503);
      return jsonError(res, 503, 'PRONUNCIATION_UNAVAILABLE', 'Serviço de pronúncia temporariamente indisponível. Tente novamente.');
    }
    throw err;
  }

  const { data: attemptData, error: attemptError } = await auth.supabase.rpc('register_word_practice_attempt', {
    p_owner_type: ownerType, p_owner_id: ownerId, p_word: word, p_max_attempts: WORD_PRACTICE_MAX_ATTEMPTS,
  });
  if (attemptError) {
    safeLog('pronunciation-training/word-assess', 'word_attempt_rpc_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao registrar a tentativa.');
  }
  const attempt = (attemptData ?? {}) as { error?: string; attemptsUsed?: number };
  if (attempt.error) {
    const status = WORD_ATTEMPT_ERROR_STATUS[attempt.error] ?? 500;
    if (attempt.error === 'WORD_ATTEMPT_LIMIT_REACHED') {
      return res.status(status).json({
        code: 'WORD_ATTEMPT_LIMIT_REACHED',
        message: `Você já usou as ${WORD_PRACTICE_MAX_ATTEMPTS} tentativas desta palavra.`,
        attemptsUsed: attempt.attemptsUsed ?? WORD_PRACTICE_MAX_ATTEMPTS,
        maxAttempts: WORD_PRACTICE_MAX_ATTEMPTS,
      });
    }
    if (attempt.error === 'OWNER_NOT_FOUND') {
      return jsonError(res, status, 'OWNER_NOT_FOUND', 'Contexto de treino não encontrado.');
    }
    return jsonError(res, status, attempt.error, 'Não foi possível registrar a tentativa.');
  }
  const attemptsUsed = typeof attempt.attemptsUsed === 'number' ? attempt.attemptsUsed : 1;

  let wav: Buffer;
  try {
    wav = Buffer.from(audioBase64, 'base64');
  } catch {
    await refundWordPracticeAttempt(auth.userId, ownerType, ownerId, word);
    return jsonError(res, 400, 'INVALID_AUDIO', 'Áudio inválido.');
  }

  try {
    const assessed = await assessPronunciation({
      wav, referenceText: word, language: recognitionLocale, logLabel: `word:${ownerId}`,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      result: assessed.result,
      attemptsUsed,
      maxAttempts: WORD_PRACTICE_MAX_ATTEMPTS,
    });
  } catch (err) {
    const code: PronunciationFailCode = err instanceof PronunciationServiceError ? err.code : 'AZURE_CANCELED';
    // Provider failure → refund so the attempt is NOT consumed (parity with the
    // old token path, where a failure before any client evaluation was refunded).
    await refundWordPracticeAttempt(auth.userId, ownerType, ownerId, word);
    const providerSignal = mapPronunciationFailCodeToProviderSignal(code);
    if (providerSignal) {
      try {
        await recordAndAlertBrowserProviderFailure({
          featureKey: 'pronunciation.assess_text', providerRaw: 'azure',
          httpStatus: providerSignal.httpStatus, errorCode: providerSignal.errorCode,
          service: 'speech_sdk', userId: auth.userId,
        });
      } catch { /* isolated */ }
    }
    safeLog('pronunciation-training/word-assess', `failed_${code.toLowerCase()}`, 502);
    const message =
      code === 'AZURE_NO_MATCH' ? 'Nenhuma fala detectada.'
      : code === 'AUDIO_EMPTY' || code === 'AUDIO_DECODE_FAILED' ? 'Áudio inválido.'
      : code === 'AZURE_TIMEOUT' ? 'Análise demorou.'
      : 'Erro. Tente novamente.';
    const status = code === 'AUDIO_EMPTY' || code === 'AUDIO_DECODE_FAILED' ? 400 : 502;
    return res.status(status).json({
      code, message,
      attemptsUsed: Math.max(0, attemptsUsed - 1),
      maxAttempts: WORD_PRACTICE_MAX_ATTEMPTS,
    });
  }
}

export default async function handler(req: any, res: any) {
  const slug = resolveSlug(req, '/api/pronunciation-training');
  switch (slug) {
    case 'generate-text':     return handleGenerateText(req, res);
    case 'token':             return handleToken(req, res);
    case 'word-assess':       return handleWordAssess(req, res);
    case 'start':             return handleTrainingStart(req, res);
    case 'complete':          return handleTrainingComplete(req, res);
    case 'assess':            return handleTrainingAssess(req, res);
    case 'fail':              return handleTrainingFail(req, res);
    case 'plan-entitlements': return handlePlanEntitlements(req, res);
    case 'evaluate':          return handlePromotionEvaluate(req, res);
    default:                  return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
