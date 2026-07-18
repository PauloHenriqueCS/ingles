import { requireAuth } from '../_auth';
import { isValidUuid, buildStatusResponse, rowToAssessment } from '../../src/lib/pronunciationAssessment';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import type { PronunciationNormalizedResult, PronunciationFailCode } from '../../src/types';
import { methodGuard, safeLog, resolveSlug } from '../_helpers';
import {
  executeAiGatewayCall,
  getProductionDeps,
  getSharedServiceClient,
  authorizeProviderSession,
  reconcileEventCost,
  rebuildDailyBucketForEvent,
  estimateAudioSecondsCeiling,
} from '../_ai-gateway/index';
import type { GatewayUsageMetric, GatewayDeps } from '../_ai-gateway/index';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { checkRecordingDuration } from '../_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../../src/domain/entitlements/entitlement-messages';

// ─── start ────────────────────────────────────────────────────────────────────

type ReserveResult = {
  action?: 'created' | 'reactivated' | 'existing_processing' | 'restarted';
  error?: string;
  assessmentId?: string;
  referenceText?: string;
};

const AZURE_ERROR_STATUS: Record<string, number> = {
  AZURE_SPEECH_NOT_CONFIGURED: 503,
  AZURE_SPEECH_AUTH_FAILED: 503,
  AZURE_SPEECH_TIMEOUT: 504,
  AZURE_SPEECH_RATE_LIMITED: 503,
  AZURE_SPEECH_UNAVAILABLE: 503,
};
const AZURE_ERROR_MESSAGES: Record<string, string> = {
  AZURE_SPEECH_NOT_CONFIGURED: 'O serviço de pronúncia ainda não está configurado.',
  AZURE_SPEECH_AUTH_FAILED: 'Não foi possível autenticar o serviço de pronúncia.',
  AZURE_SPEECH_TIMEOUT: 'O serviço de pronúncia demorou para responder.',
  AZURE_SPEECH_RATE_LIMITED: 'O serviço de pronúncia está temporariamente indisponível.',
  AZURE_SPEECH_UNAVAILABLE: 'O serviço de pronúncia está temporariamente indisponível.',
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

// ── pronunciation.assess_text — Gateway session bridge ────────────────────────
// The physical Azure call happens entirely in the browser (Speech SDK), so it
// cannot be wrapped with executeAiGatewayCall. Instead, ai_provider_sessions
// is the authorization/correlation bridge (per the AI Gateway foundation):
// this backend authorizes a session when issuing the token, and the browser
// later reports technical completion through the already-authenticated
// /complete and /fail endpoints below — never a direct browser→Supabase write.
//
// Session creation/completion is itself gated by pronunciation.assess_text's
// own runtime policy: while legacy (Fase A of Etapa 9), none of this runs —
// no session row, no gatewaySessionId in the response, zero new behavior.

const ASSESS_TEXT_FEATURE_KEY = 'pronunciation.assess_text';
// Reasonable upper bound for a single continuous assessment recording —
// generous relative to the Speech SDK's own analysis timeout (3× audio
// duration, capped at 5 minutes in pronunciationFlow.ts), so genuine
// recordings are never rejected while implausible values still are.
const MAX_ASSESS_TEXT_DURATION_SECONDS = 900;

async function maybeAuthorizeAssessTextSession(
  gatewayDeps: GatewayDeps,
  userId: string,
  assessmentId: string,
  ephemeralToken: string,
  authorizationExpiresAt: Date,
): Promise<string | undefined> {
  try {
    const policy = await gatewayDeps.policyResolver.resolvePolicy({
      featureKey: ASSESS_TEXT_FEATURE_KEY,
      provider: 'azure',
      userId,
      actorType: 'user',
      executionLocation: 'frontend',
    });
    if (policy.gatewayMode !== 'observe') return undefined;

    // Etapa 11 correction — the server-authorized ceiling (never a
    // client-chosen duration) is what a real reservation would be sized
    // against; recorded here so it is genuinely computed and auditable per
    // session. Not yet tied to a live blocking reservation: this bridge's
    // physical call happens entirely client-side (like
    // conversation.webrtc_connect), so there is no executeAiGatewayCall
    // invocation here for an enforce-mode reservation to attach to — the
    // same documented, honest limitation class as Realtime's session
    // control (see handleSessionControl's doc comment). Real consumption is
    // still only ever recorded from the completed session
    // (recordAssessTextUsageEvent, durationSeconds validated server-side),
    // never a client-reported estimate.
    const estimatedAudioSeconds = estimateAudioSecondsCeiling(MAX_ASSESS_TEXT_DURATION_SECONDS);

    const { sessionId } = await authorizeProviderSession(
      gatewayDeps.usageRepository,
      {
        featureKey: ASSESS_TEXT_FEATURE_KEY,
        provider: 'azure',
        userId,
        initiatedByUserId: userId,
        internalSessionType: 'pronunciation_assessment',
        internalSessionId: assessmentId,
        authorizationExpiresAt,
        metadata: { endpoint: 'pronunciation/start', estimatedAudioSecondsCeiling: estimatedAudioSeconds.quantity },
      },
      ephemeralToken,
    );
    return sessionId;
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextAuthorize.failed', { message: String(e) });
    return undefined; // fail-open: token issuance must never be blocked by this
  }
}

/**
 * Atomically completes (or fails) the ai_provider_sessions row for a
 * pronunciation.assess_text session, re-validating ownership/feature/
 * provider/non-terminal-status server-side — the client-supplied
 * gatewaySessionId is never trusted beyond "which row to look up."
 * Returns the row if the transition succeeded, or null if the session
 * didn't exist, didn't belong to this user, or was already terminal
 * (idempotent no-op — never double-counts).
 */
async function transitionAssessTextSession(
  userId: string,
  gatewaySessionId: string,
  update: { status: 'completed'; durationSeconds: number } | { status: 'failed' },
): Promise<{ id: string } | null> {
  const supabase = getSharedServiceClient();
  const payload: Record<string, unknown> = {
    status: update.status,
    ended_at: new Date().toISOString(),
  };
  if (update.status === 'completed') payload.duration_seconds = update.durationSeconds;

  const { data, error } = await supabase
    .from('ai_provider_sessions')
    .update(payload)
    .eq('id', gatewaySessionId)
    .eq('user_id', userId)
    .eq('feature_key', ASSESS_TEXT_FEATURE_KEY)
    .eq('provider', 'azure')
    .in('status', ['authorized', 'connecting', 'active'])
    .select('id')
    .maybeSingle();

  if (error || !data) return null;
  return data as { id: string };
}

/**
 * Records the completed physical Azure call as a normal ai_usage_event +
 * metrics, exactly like every backend-wrapped feature — the only difference
 * is the "physical call" already happened in the browser, so there is no
 * invoke() to wrap; the event is recorded directly once the browser's
 * authenticated completion report is validated and the session transition
 * above has already succeeded.
 */
async function recordAssessTextUsageEvent(
  gatewayDeps: GatewayDeps,
  userId: string,
  gatewaySessionId: string,
  durationSeconds: number,
): Promise<void> {
  const startedAt = gatewayDeps.clock();
  const requestId = gatewayDeps.uuidGen();
  const correlationId = gatewayDeps.uuidGen();
  const eventId = await gatewayDeps.usageRepository.startEvent({
    requestId,
    correlationId,
    userId,
    initiatedByUserId: userId,
    actorType: 'user',
    featureKey: ASSESS_TEXT_FEATURE_KEY,
    provider: 'azure',
    service: 'pronunciation_assessment_sdk',
    executionLocation: 'frontend',
    isBillable: true,
    attemptNumber: 1,
    callSequence: 1,
    resourceType: 'ai_provider_session',
    resourceId: gatewaySessionId,
    metadata: { endpoint: 'pronunciation/complete' },
    startedAt,
  });

  await gatewayDeps.usageRepository.completeEvent(eventId, { latencyMs: gatewayDeps.clock() - startedAt });

  const metrics: GatewayUsageMetric[] = [
    { metricKey: 'provider_requests', unitType: 'request', quantity: 1, isBillable: false, measurementSource: 'client_report' },
    { metricKey: 'audio_seconds', unitType: 'second', quantity: durationSeconds, isBillable: true, measurementSource: 'client_sdk_reported' },
  ];
  await gatewayDeps.usageRepository.insertMetrics(eventId, metrics);

  try {
    await reconcileEventCost(eventId, {
      usageRepository: gatewayDeps.usageRepository,
      pricingRepository: gatewayDeps.pricingRepository,
      logger: gatewayDeps.logger,
    });
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextCost.failed', { message: String(e) });
  }

  try {
    await rebuildDailyBucketForEvent(eventId, {
      dailyRollupRepository: gatewayDeps.dailyRollupRepository,
      logger: gatewayDeps.logger,
    });
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextRollup.failed', { message: String(e) });
  }
}

async function completeAssessTextGatewaySession(
  gatewayDeps: GatewayDeps,
  userId: string,
  gatewaySessionId: string,
  durationSeconds: number,
): Promise<void> {
  try {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > MAX_ASSESS_TEXT_DURATION_SECONDS) {
      gatewayDeps.logger('gateway.assessTextComplete.rejectedDuration', { durationSeconds });
      return;
    }
    const session = await transitionAssessTextSession(userId, gatewaySessionId, { status: 'completed', durationSeconds });
    if (!session) return; // unknown/foreign/already-terminal — idempotent no-op

    const policy = await gatewayDeps.policyResolver.resolvePolicy({
      featureKey: ASSESS_TEXT_FEATURE_KEY, provider: 'azure', userId,
      actorType: 'user', executionLocation: 'frontend',
    });
    if (policy.gatewayMode !== 'observe') return;

    await recordAssessTextUsageEvent(gatewayDeps, userId, gatewaySessionId, durationSeconds);
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextComplete.failed', { message: String(e) });
    // fail-open: never throw — this must not affect the pedagogical response
  }
}

async function failAssessTextGatewaySession(
  gatewayDeps: GatewayDeps,
  userId: string,
  gatewaySessionId: string,
): Promise<void> {
  try {
    await transitionAssessTextSession(userId, gatewaySessionId, { status: 'failed' });
    // No ai_usage_event is created here: unlike /complete, we cannot prove a
    // physical Azure call was actually attempted (the browser may call /fail
    // before ever reaching the Speech SDK step) — never invent an event.
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextFail.failed', { message: String(e) });
  }
}

async function handleStart(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const body = req.body ?? {};
  const { textVersionId, attemptId } = body;
  if (!textVersionId || typeof textVersionId !== 'string' || !isValidUuid(textVersionId)) {
    return res.status(400).json({ code: 'INVALID_TEXT_VERSION_ID', message: 'A versão do texto informada é inválida.' });
  }
  if (!attemptId || typeof attemptId !== 'string' || !isValidUuid(attemptId)) {
    return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'O identificador de tentativa é inválido.' });
  }
  const azureRegion = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!azureRegion) {
    return res.status(503).json({ code: 'AZURE_SPEECH_NOT_CONFIGURED', message: AZURE_ERROR_MESSAGES.AZURE_SPEECH_NOT_CONFIGURED });
  }

  let entitlements;
  try {
    entitlements = await getCurrentUserPlanEntitlements(auth.userId);
  } catch {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Não foi possível verificar seu plano. Tente novamente.' });
  }
  if (!entitlements.pronunciation.enabled) {
    return res.status(403).json({ code: 'FEATURE_DISABLED', message: ENTITLEMENT_MESSAGES.featureUnavailable });
  }
  if (!entitlements.pronunciation.evaluations.canStart) {
    const code = entitlements.pronunciation.evaluations.state === 'monthly_limit_reached' ? 'MONTHLY_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED';
    return res.status(403).json({ code, message: ENTITLEMENT_MESSAGES.pronunciationEvaluationsExhausted });
  }

  const { data: reserveData, error: rpcError } = await supabase.rpc('reserve_pronunciation_assessment', {
    p_text_version_id: textVersionId, p_azure_region: azureRegion, p_attempt_id: attemptId,
  });
  if (rpcError) {
    console.error('[pronunciation/start] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao reservar a avaliação.' });
  }
  const result = (reserveData ?? {}) as ReserveResult;
  if (result.error === 'UNAUTHORIZED') return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  if (result.error === 'TEXT_VERSION_NOT_FOUND') return res.status(404).json({ code: 'TEXT_VERSION_NOT_FOUND', message: 'A versão final do texto não foi encontrada.' });
  if (result.error === 'TEXT_VERSION_NOT_ELIGIBLE') return res.status(409).json({ code: 'TEXT_VERSION_NOT_ELIGIBLE', message: 'Finalize e salve o texto antes de solicitar a análise.' });
  if (result.error === 'ASSESSMENT_ALREADY_COMPLETED') return res.status(409).json({ code: 'ASSESSMENT_ALREADY_COMPLETED', message: 'Este texto já possui uma análise de pronúncia.', assessmentId: result.assessmentId });
  if (result.error === 'ASSESSMENT_NOT_RETRYABLE') return res.status(409).json({ code: 'ASSESSMENT_NOT_RETRYABLE', message: 'Esta avaliação não pode ser reiniciada.', assessmentId: result.assessmentId });
  if (result.error === 'ASSESSMENT_IN_PROGRESS') return res.status(409).json({ code: 'ASSESSMENT_IN_PROGRESS', message: 'Já existe uma análise em andamento para este texto.', assessmentId: result.assessmentId });
  if (result.error) {
    console.error('[pronunciation/start] Unexpected reservation result:', result.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao reservar a avaliação.' });
  }
  const assessmentId = result.assessmentId as string;
  const referenceText = result.referenceText as string;
  const isOurSlot = result.action === 'created' || result.action === 'reactivated' || result.action === 'existing_processing' || result.action === 'restarted';
  const gatewayDeps = getProductionDeps();
  let tokenResult: Awaited<ReturnType<typeof issueAzureSpeechToken>>;
  try {
    tokenResult = await executeAiGatewayCall(
      {
        featureKey: 'pronunciation.start_assessment',
        provider: 'azure',
        service: 'speech_sts',
        userId: auth.userId,
        initiatedByUserId: auth.userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'pronunciation_assessment',
        resourceId: assessmentId,
        technicalMetadata: { endpoint: 'pronunciation/start' },
      },
      () => issueAzureSpeechToken(),
      gatewayDeps,
      extractTokenMetrics,
    );
  } catch (err) {
    if (isOurSlot && assessmentId) {
      const errorCode = err instanceof AzureSpeechError ? err.code : 'TOKEN_ISSUE_FAILED';
      try {
        await supabase.rpc('compensate_pronunciation_assessment', { p_assessment_id: assessmentId, p_error_code: errorCode, p_error_message: 'Falha ao emitir credencial temporária de pronúncia.' });
      } catch (compensateErr) {
        console.error('[pronunciation/start] Compensation RPC failed:', compensateErr instanceof Error ? compensateErr.message : 'unknown');
      }
    }
    if (err instanceof AzureSpeechError) {
      return res.status(AZURE_ERROR_STATUS[err.code] ?? 503).json({ configured: false, code: err.code, message: AZURE_ERROR_MESSAGES[err.code] ?? AZURE_ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE });
    }
    console.error('[pronunciation/start] Unexpected token error:', err instanceof Error ? err.message : 'unknown');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao preparar a análise.' });
  }

  // Additive, retrocompatible: gatewaySessionId is only present when
  // pronunciation.assess_text is in observe mode (Fase A: always absent).
  const gatewaySessionId = await maybeAuthorizeAssessTextSession(
    gatewayDeps,
    auth.userId,
    assessmentId,
    tokenResult.token,
    new Date(Date.now() + tokenResult.expiresInSeconds * 1000),
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    assessmentId, attemptId, token: tokenResult.token, region: tokenResult.region,
    language: 'en-US', referenceText,
    ...(gatewaySessionId ? { gatewaySessionId } : {}),
  });
}

// ─── complete ─────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES_COMPLETE = 2 * 1024 * 1024;

function isFiniteScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}
function validateResult(r: unknown): r is PronunciationNormalizedResult {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (!isFiniteScore(o.pronunciationScore)) return false;
  if (!isFiniteScore(o.accuracyScore)) return false;
  if (!isFiniteScore(o.fluencyScore)) return false;
  if (!isFiniteScore(o.completenessScore)) return false;
  if (o.prosodyScore !== null && !isFiniteScore(o.prosodyScore)) return false;
  if (typeof o.recognizedText !== 'string' || o.recognizedText.length > 50_000) return false;
  if (!Array.isArray(o.wordsJson) || o.wordsJson.length > 5_000) return false;
  if (!Array.isArray(o.rawSegments) || o.rawSegments.length > 1_000) return false;
  if (typeof o.audioDurationSeconds !== 'number' || !Number.isFinite(o.audioDurationSeconds)) return false;
  return true;
}

async function handleComplete(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const raw = req.body ?? {};
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES_COMPLETE) {
    return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload muito grande.' });
  }
  const { assessmentId, attemptId, result, gatewaySessionId } = raw;
  if (!isValidUuid(assessmentId)) return res.status(400).json({ code: 'INVALID_ASSESSMENT_ID', message: 'assessmentId inválido.' });
  if (!isValidUuid(attemptId)) return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'attemptId inválido.' });
  if (!validateResult(result)) return res.status(400).json({ code: 'INVALID_RESULT', message: 'Resultado inválido ou fora do intervalo permitido.' });

  // Server-side re-validation of the plan's recording-duration cap — the
  // client-side auto-stop is UX only, this is the definitive check. A
  // rejected duration releases the reservation slot (RESULT_INVALID) rather
  // than leaving the assessment stuck "processing", so the user can retry.
  let entitlements;
  try {
    entitlements = await getCurrentUserPlanEntitlements(auth.userId);
  } catch {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Não foi possível verificar seu plano. Tente novamente.' });
  }
  const durationCheck = checkRecordingDuration(
    result.audioDurationSeconds, entitlements.pronunciation.maxRecordingSeconds, entitlements.pronunciation.maxRecordingUnlimited,
  );
  if (!durationCheck.allowed) {
    try {
      await supabase.rpc('fail_pronunciation_assessment', { p_assessment_id: assessmentId, p_attempt_id: attemptId, p_error_code: 'RESULT_INVALID' });
    } catch (e) {
      console.error('[pronunciation/complete] Failed to release slot after duration rejection:', e instanceof Error ? e.message : 'unknown');
    }
    return res.status(413).json({ code: durationCheck.code, message: durationCheck.message });
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc('complete_pronunciation_assessment', {
    p_assessment_id: assessmentId, p_attempt_id: attemptId,
    p_pronunciation_score: result.pronunciationScore, p_accuracy_score: result.accuracyScore,
    p_fluency_score: result.fluencyScore, p_completeness_score: result.completenessScore,
    p_prosody_score: result.prosodyScore ?? null, p_recognized_text: result.recognizedText,
    p_words_json: result.wordsJson, p_raw_result_json: result.rawSegments,
    p_audio_duration_s: result.audioDurationSeconds,
  });
  if (rpcError) {
    console.error('[pronunciation/complete] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao salvar o resultado.' });
  }
  const rpc = (rpcData ?? {}) as Record<string, unknown>;
  if (rpc.error === 'UNAUTHORIZED') return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  if (rpc.error === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND', message: 'Avaliação não encontrada.' });
  if (rpc.error === 'ASSESSMENT_ALREADY_COMPLETED') return res.status(409).json({ code: 'ASSESSMENT_ALREADY_COMPLETED', message: 'Este texto já possui uma análise concluída.' });
  if (rpc.error === 'ATTEMPT_MISMATCH') return res.status(409).json({ code: 'ATTEMPT_MISMATCH', message: 'Esta tentativa não corresponde à tentativa ativa.' });
  if (rpc.error) {
    console.error('[pronunciation/complete] Unexpected RPC result:', rpc.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao salvar o resultado.' });
  }

  // Additive Gateway telemetry — never affects the response above. Only runs
  // when the client (still authenticated) reports a gatewaySessionId, which
  // is only ever issued when pronunciation.assess_text is in observe mode.
  if (typeof gatewaySessionId === 'string' && isValidUuid(gatewaySessionId)) {
    try {
      await completeAssessTextGatewaySession(getProductionDeps(), auth.userId, gatewaySessionId, result.audioDurationSeconds);
    } catch { /* fail-open — already isolated inside, this is a final safety net */ }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ assessmentId, status: 'completed', result });
}

// ─── fail ─────────────────────────────────────────────────────────────────────

const ALLOWED_CODES = new Set<PronunciationFailCode>([
  'AUDIO_DECODE_FAILED', 'AUDIO_EMPTY', 'AZURE_NO_MATCH', 'AZURE_CANCELED',
  'AZURE_TIMEOUT', 'AZURE_NETWORK_ERROR', 'RESULT_INVALID', 'CLIENT_INTERRUPTED',
]);

async function handleFail(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const body = req.body ?? {};
  const { assessmentId, attemptId, code, gatewaySessionId } = body;
  if (!isValidUuid(assessmentId)) return res.status(400).json({ code: 'INVALID_ASSESSMENT_ID', message: 'assessmentId inválido.' });
  if (!isValidUuid(attemptId)) return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'attemptId inválido.' });
  if (typeof code !== 'string' || !ALLOWED_CODES.has(code as PronunciationFailCode)) {
    return res.status(400).json({ code: 'INVALID_ERROR_CODE', message: 'Código de erro não permitido.' });
  }
  const { data: rpcData, error: rpcError } = await supabase.rpc('fail_pronunciation_assessment', {
    p_assessment_id: assessmentId, p_attempt_id: attemptId, p_error_code: code,
  });
  if (rpcError) {
    console.error('[pronunciation/fail] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }
  const rpc = (rpcData ?? {}) as Record<string, unknown>;
  if (rpc.error === 'UNAUTHORIZED') return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  if (rpc.error === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND', message: 'Avaliação não encontrada.' });
  if (rpc.error) {
    console.error('[pronunciation/fail] Unexpected RPC result:', rpc.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }

  // Additive Gateway telemetry — never affects the response above.
  if (typeof gatewaySessionId === 'string' && isValidUuid(gatewaySessionId)) {
    try {
      await failAssessTextGatewaySession(getProductionDeps(), auth.userId, gatewaySessionId);
    } catch { /* fail-open — already isolated inside, this is a final safety net */ }
  }

  return res.status(200).json({ status: rpc.action ?? 'no_op' });
}

// ─── status ───────────────────────────────────────────────────────────────────

async function handleStatus(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { textVersionId } = req.query ?? {};
  if (!isValidUuid(textVersionId)) return res.status(400).json({ error: 'textVersionId inválido.' });
  const { userId, supabase } = auth;
  const { data: review, error: reviewError } = await supabase.from('english_reviews').select('id').eq('id', textVersionId).eq('user_id', userId).maybeSingle();
  if (reviewError) { safeLog('pronunciation/status', 'db_error', 500); return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' }); }
  if (!review) return res.status(404).json({ code: 'NOT_FOUND', message: 'Revisão não encontrada.' });
  const { data: row, error: assessmentError } = await supabase.from('pronunciation_assessments').select('*').eq('text_version_id', textVersionId).eq('user_id', userId).maybeSingle();
  if (assessmentError) { safeLog('pronunciation/status', 'db_error', 500); return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' }); }
  const assessment = row ? rowToAssessment(row as Record<string, unknown>) : null;
  return res.json(buildStatusResponse(assessment));
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  const slug = resolveSlug(req, '/api/pronunciation');
  switch (slug) {
    case 'start':    return handleStart(req, res);
    case 'complete': return handleComplete(req, res);
    case 'fail':     return handleFail(req, res);
    case 'status':   return handleStatus(req, res);
    default:         return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
