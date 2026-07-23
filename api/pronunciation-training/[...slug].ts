import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog, sanitizeProviderError, resolveSlug } from '../_helpers';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens } from '../_ai-gateway/index';
import type { GatewayUsageMetric } from '../_ai-gateway/index';
import { applyRateLimit } from '../_rateLimit';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { checkFeatureConfigError, checkRecordingDuration } from '../_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../../src/domain/entitlements/entitlement-messages';
import { evaluateSkillPromotion } from '../../src/lib/promotionService';
import type { PromotionTrigger } from '../../src/domain/promotion/promotion-types';
import type { PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';
import type { PronunciationNormalizedResult, PronunciationFailCode } from '../../src/types';
import { isValidUuid } from '../../src/lib/pronunciationAssessment';
import { getTodaySP } from '../../src/lib/timezone';

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
  return { entitlements };
}

function isAccessDenial(v: AccessDenial | { entitlements: PlanEntitlementsSnapshot }): v is AccessDenial {
  return 'status' in v;
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

const WORD_TARGETS: Record<string, { min: number; max: number }> = {
  A1: { min: 50, max: 80  }, A2: { min: 50, max: 80  },
  B1: { min: 80, max: 120 }, B2: { min: 80, max: 120 },
  C1: { min: 120, max: 160 }, C2: { min: 120, max: 160 },
};

const LEVEL_GUIDE: Record<string, string> = {
  A1: 'A1 (beginner): simple present tense, common everyday words, very short sentences',
  A2: 'A2 (elementary): simple past and present, everyday vocabulary, short connected sentences',
  B1: 'B1 (intermediate): varied tenses, compound sentences, everyday and some idiomatic expressions',
  B2: 'B2 (upper-intermediate): complex structures, nuanced vocabulary, subordinate clauses',
  C1: 'C1 (advanced): sophisticated grammar, wide vocabulary, complex ideas expressed naturally',
  C2: 'C2 (proficient): native-like fluency, subtle distinctions, rich idiomatic language',
};

function buildSystemPrompt(level: string): string {
  const { min, max } = WORD_TARGETS[level] ?? { min: 80, max: 120 };
  return `You write short English texts for pronunciation practice.

Level: ${LEVEL_GUIDE[level] ?? LEVEL_GUIDE.B1}
Word count target: ${min}–${max} words (count carefully before submitting)

Rules:
- Write a vivid, specific scenario featuring a real decision, small conflict, or unexpected turn
- Use concrete names, specific places, and a moment of tension or surprise
- Avoid: daily-routine lists, hobby catalogues, generic "I woke up and…" intros
- Sentences should be short to medium length and flow naturally when read aloud
- No bullet points, no headings, no titles — just a continuous narrative paragraph
- Write in third person or second person; no first-person "I" narrator
- Vocabulary must be natural for ${level} — do not inflate difficulty to "test" pronunciation

Output only the text. Nothing else.`;
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

  const { data: existing, error: existingError } = await supabase
    .from('pronunciation_training_sessions')
    .select('id, level, generated_text, status, pronunciation_score, accuracy_score, fluency_score, completeness_score, prosody_score, recognized_text, words_json, raw_result_json, audio_duration_seconds')
    .eq('user_id', userId)
    .eq('practice_date', practiceDate)
    .maybeSingle();
  if (existingError) {
    safeLog('pronunciation-training/generate-text', 'existing_lookup_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível carregar o texto de hoje. Tente novamente.');
  }

  // Unlimited-plan "new round" reset — the ONLY case where an already-
  // 'completed' session for today is not simply returned as-is. `forceNew`
  // is a client-supplied UX hint (the user clicked "Gerar outro texto"); the
  // actual authorization is `entitlements.pronunciation.evaluations.unlimited`,
  // resolved server-side above and never trusted from the request body — a
  // limited-plan account sending forceNew:true still gets the existing
  // completed row back unchanged, exactly like today. See migration
  // 20260724020000_pronunciation_training_unlimited_daily_reset.
  const { forceNew } = (req.body ?? {}) as { forceNew?: unknown };
  const existingRow = existing as TrainingSessionRow | null;
  const wantsNewRound = Boolean(forceNew) && entitlements.pronunciation.evaluations.unlimited && existingRow?.status === 'completed';

  if (existingRow && !wantsNewRound) {
    safeLog('pronunciation-training/generate-text', 'returned_existing', 200);
    return res.status(200).json(buildGenerateTextResponse(existingRow));
  }

  if (!existingRow && !dailyPronunciationTrainingAllowedByPlan(entitlements)) {
    return jsonError(res, 403, 'DAILY_LIMIT_REACHED', ENTITLEMENT_MESSAGES.pronunciationTrainingTextAlreadyGeneratedToday);
  }

  let userLevel = 'A2';
  try {
    const { data } = await supabase.from('english_learning_memory').select('current_level').eq('user_id', userId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (data?.current_level && typeof data.current_level === 'string') userLevel = data.current_level;
  } catch { /* Use default */ }

  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'Serviço de IA não configurado.');

  const openai = new OpenAI({ apiKey, timeout: GENERATE_TIMEOUT_MS });
  const gatewayDeps = getProductionDeps();
  try {
    const completion = await executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'pronunciation.generate_text',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
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
        estimatedMetrics: estimateTextTokens(buildSystemPrompt(userLevel).length + 'Write the text now.'.length, 400),
      },
      () => openai.chat.completions.create({
        model: AI_MODEL,
        messages: [{ role: 'system', content: buildSystemPrompt(userLevel) }, { role: 'user', content: 'Write the text now.' }],
        temperature: 0.9,
        max_tokens: 400,
      }),
      gatewayDeps,
      extractGenerateTextMetrics,
    );
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    if (!text) return jsonError(res, 503, 'AI_UNAVAILABLE', 'Não foi possível gerar o texto. Tente novamente.');

    // Atomic get-or-create: if a concurrent request already created today's
    // row first, this returns THAT row and discards the text generated
    // here — never two sessions for the same user+day, even under a real
    // race between two simultaneous requests.
    const { data: created, error: createError } = await supabase.rpc('create_pronunciation_training_text', {
      p_practice_date: practiceDate, p_level: userLevel, p_generated_text: text, p_force_new: wantsNewRound,
    });
    if (createError) {
      safeLog('pronunciation-training/generate-text', 'persist_rpc_error', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível salvar o texto gerado. Tente novamente.');
    }
    const result = (created ?? {}) as Record<string, unknown>;
    if (result.error) {
      safeLog('pronunciation-training/generate-text', 'persist_rejected', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível salvar o texto gerado. Tente novamente.');
    }
    safeLog('pronunciation-training/generate-text', 'success', 200);
    return res.status(200).json({
      sessionId: result.sessionId,
      text: result.text,
      level: result.level,
      status: result.status,
      ...(result.result ? { result: result.result } : {}),
    });
  } catch (err) {
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

async function handleToken(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const tokenAccess = await requirePronunciationEnabled(auth.userId);
  if (isAccessDenial(tokenAccess)) return jsonError(res, tokenAccess.status, tokenAccess.code, tokenAccess.message);
  if (!await applyRateLimit(res, auth.userId, 'pronunciation-training-token')) return;

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
    return res.status(200).json({ token, region, expiresInSeconds });
  } catch (err) {
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

  const practiceDate = getTodaySP();
  const { data: reserveData, error: rpcError } = await supabase.rpc('reserve_pronunciation_training_assessment', {
    p_practice_date: practiceDate, p_azure_region: azureRegion, p_attempt_id: attemptId,
  });
  if (rpcError) {
    safeLog('pronunciation-training/start', 'reserve_rpc_error', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao reservar a avaliação.');
  }
  const reserved = (reserveData ?? {}) as { error?: string; sessionId?: string; referenceText?: string };
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
    language: 'en-US', referenceText,
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

  // Server-side re-validation of the plan's recording-duration cap — the
  // client-side auto-stop (useAudioRecorder's maxDurationMs) is UX only,
  // this is the definitive check, exactly mirroring
  // api/pronunciation/[...slug].ts's handleComplete. A rejected duration
  // releases the reservation (RESULT_INVALID) instead of leaving the
  // session stuck in 'processing', so the user can retry the same day.
  const access = await requirePronunciationEnabled(userId);
  if (isAccessDenial(access)) return jsonError(res, access.status, access.code, access.message);
  const { entitlements } = access;
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
  if (rpc.error === 'ASSESSMENT_ALREADY_COMPLETED') return jsonError(res, 409, 'ASSESSMENT_ALREADY_COMPLETED', 'O texto de hoje já possui uma análise concluída.');
  if (rpc.error === 'ATTEMPT_MISMATCH') return jsonError(res, 409, 'ATTEMPT_MISMATCH', 'Esta tentativa não corresponde à tentativa ativa.');
  if (rpc.error) {
    safeLog('pronunciation-training/complete', 'rpc_unexpected', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao salvar o resultado.');
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ sessionId, status: 'completed', result });
}

// ─── POST /api/pronunciation-training/fail ────────────────────────────────────

const TRAINING_ALLOWED_FAIL_CODES = new Set<PronunciationFailCode>([
  'AUDIO_DECODE_FAILED', 'AUDIO_EMPTY', 'AZURE_NO_MATCH', 'AZURE_CANCELED',
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

export default async function handler(req: any, res: any) {
  const slug = resolveSlug(req, '/api/pronunciation-training');
  switch (slug) {
    case 'generate-text':     return handleGenerateText(req, res);
    case 'token':             return handleToken(req, res);
    case 'start':             return handleTrainingStart(req, res);
    case 'complete':          return handleTrainingComplete(req, res);
    case 'fail':              return handleTrainingFail(req, res);
    case 'plan-entitlements': return handlePlanEntitlements(req, res);
    case 'evaluate':          return handlePromotionEvaluate(req, res);
    default:                  return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
