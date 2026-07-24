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
  buildBudgetScopes,
  estimateConservativeCostUsd,
  reconcileSessionReservation,
  releaseSessionReservation,
} from '../_ai-gateway/index';
import type { GatewayUsageMetric, GatewayDeps, GatewayCallContext } from '../_ai-gateway/index';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { checkRecordingDuration, checkFeatureConfigError } from '../_entitlements/require-feature-access';
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
// Correction: session creation/completion here used to be gated on
// pronunciation.assess_text's own gatewayMode === 'observe' — but the
// physical Azure call (and its real cost) happens unconditionally, in every
// mode, since it is driven entirely by the browser's Speech SDK regardless
// of what this backend's runtime policy says. Gating telemetry on gatewayMode
// meant the mode controlled billing, not just enforcement — exactly backwards
// (mode must never decide whether cost gets recorded, only how the Gateway
// enforces). This bridge now always authorizes a session and always records
// usage, in legacy, observe, and enforce alike.

const ASSESS_TEXT_FEATURE_KEY = 'pronunciation.assess_text';
// Reasonable upper bound for a single continuous assessment recording —
// generous relative to the Speech SDK's own analysis timeout (3× audio
// duration, capped at 5 minutes in pronunciationFlow.ts), so genuine
// recordings are never rejected while implausible values still are.
const MAX_ASSESS_TEXT_DURATION_SECONDS = 900;

export interface AssessTextBudgetReservation {
  allowed: boolean;
  reservationId: string | null;
  blockedReason: 'QUOTA_EXCEEDED' | 'BUDGET_EXCEEDED' | null;
}

/**
 * Upfront AI Gateway budget reservation for this session's assess_text
 * cost — mirrors conversation.realtime_usage's reserveRealtimeSessionBudget
 * (api/_realtime-budget.ts), sized by the same worst-case ceiling already
 * computed below (estimateAudioSecondsCeiling) × real provider_pricing for
 * the audio_seconds metric, via the same centralized cost-estimator and the
 * same atomic reserve_gateway_usage_v1.
 *
 * CORRECTION (independent audit finding): this used to be fail-open — a
 * blocked or failed reservation logged and let token issuance proceed
 * anyway, which meant `pronunciation.assess_text` could exceed an active
 * global budget by design. Now mirrors reserveRealtimeSessionBudget's own
 * philosophy exactly: `allowed: false` on an explicit block AND on any
 * reservation-infrastructure failure (cannot prove the call is affordable
 * -> treat as not affordable, never silently let it through). The caller
 * (handleStart, below) must call this BEFORE issuing any Azure credential
 * and refuse to proceed when `allowed` is false.
 *
 * Exported (alongside the default route handler) so tests can prove
 * conversation.realtime_usage and pronunciation.assess_text share the same
 * budget bucket without needing to drive the full /start HTTP handler
 * (Azure token issuance, RPC mocks, etc.) — see
 * api/__tests__/budget-ledger-scenario.test.ts.
 */
export async function reserveAssessTextBudget(
  gatewayDeps: GatewayDeps,
  userId: string,
  audioSecondsCeiling: number,
): Promise<AssessTextBudgetReservation> {
  if (!gatewayDeps.reservationsRepository) {
    return { allowed: true, reservationId: null, blockedReason: null };
  }

  const context: GatewayCallContext = {
    featureKey: ASSESS_TEXT_FEATURE_KEY, provider: 'azure', userId, actorType: 'user', executionLocation: 'frontend',
  };

  let budgetScopes: ReturnType<typeof buildBudgetScopes>;
  try {
    const now = new Date(gatewayDeps.clock());
    const policy = await gatewayDeps.policyResolver.resolvePolicy(context);
    budgetScopes = buildBudgetScopes(policy, context, ASSESS_TEXT_FEATURE_KEY, now);
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextBudgetPolicy.failed', { message: String(e) });
    // Same fail-safe default as reserveRealtimeSessionBudget / the policy
    // resolver's own catch: the policy itself is unresolvable, so nothing
    // is known to be configured — never blocks a session over a transient
    // policy-fetch hiccup.
    return { allowed: true, reservationId: null, blockedReason: null };
  }
  if (budgetScopes.length === 0) {
    // No budget configured anywhere for this scope — nothing to reserve
    // against, same "never restricts when unconfigured" principle used
    // everywhere else in the Gateway.
    return { allowed: true, reservationId: null, blockedReason: null };
  }

  const now = new Date(gatewayDeps.clock());
  const metrics = [{ metricKey: 'audio_seconds', quantity: audioSecondsCeiling }];
  const costEstimate = await estimateConservativeCostUsd(
    { provider: 'azure', service: 'pronunciation_assessment_sdk', model: null, metrics },
    gatewayDeps.pricingRepository,
    now,
  );
  // Unresolved (no active price for audio_seconds) against a scope that DOES
  // have a configured budget must never collapse to $0 — reserve() itself
  // (backed by the corrected reserve_gateway_usage_v1) fails this closed,
  // exactly like every other feature.
  const estimatedCostUsd = costEstimate.resolved ? costEstimate.totalCostUsd : null;

  try {
    const reservation = await gatewayDeps.reservationsRepository.reserve({
      idempotencyKey: gatewayDeps.uuidGen(),
      userId,
      initiatedByUserId: userId,
      featureKey: ASSESS_TEXT_FEATURE_KEY,
      provider: 'azure',
      estimatedMetrics: metrics,
      budgetScopes,
      estimatedCostUsd,
      expiresInSeconds: MAX_ASSESS_TEXT_DURATION_SECONDS,
    });
    if (reservation.status === 'blocked') {
      gatewayDeps.logger('gateway.assessTextBudget.blocked', { reason: reservation.blockedReason, detail: reservation.blockedDetail });
      return { allowed: false, reservationId: null, blockedReason: reservation.blockedReason ?? 'BUDGET_EXCEEDED' };
    }
    return { allowed: true, reservationId: reservation.reservationId, blockedReason: null };
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextBudget.reserveFailed', { message: String(e) });
    // Fail-closed: a scope DOES have a configured budget but we cannot
    // currently prove this call is affordable — block rather than silently
    // let it through (matches reserveRealtimeSessionBudget's own
    // RESERVATION_FAILED philosophy).
    return { allowed: false, reservationId: null, blockedReason: 'BUDGET_EXCEEDED' };
  }
}

function extractGatewayBudgetReservationId(metadata: Record<string, unknown> | null | undefined): string | undefined {
  const v = metadata?.gatewayBudgetReservationId;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Creates the ai_provider_sessions bridge row for an assess_text session
 * whose budget reservation (if any) was ALREADY resolved and found
 * allowed by reserveAssessTextBudget, called strictly before this — the
 * Azure token has therefore already been minted and returned to the caller
 * by the time this runs. This step's own failure (a DB write failure for
 * the bridge/tracking row itself, not a budget decision) stays fail-open —
 * matching Conversation's own webrtc bridge-row authorization
 * (maybeAuthorizeWebrtcSession) — since refusing the already-issued token
 * here would strand a client holding a usable credential with no way to
 * ever report completion. If this fails AFTER a real reservation was made,
 * that reservation is released immediately rather than left to dangle
 * until the abandoned-session sweep's expiry window.
 */
async function authorizeAssessTextSession(
  gatewayDeps: GatewayDeps,
  userId: string,
  assessmentId: string,
  ephemeralToken: string,
  authorizationExpiresAt: Date,
  estimatedAudioSecondsCeiling: number,
  gatewayBudgetReservationId: string | undefined,
): Promise<string | undefined> {
  try {
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
        metadata: {
          endpoint: 'pronunciation/start',
          estimatedAudioSecondsCeiling,
          ...(gatewayBudgetReservationId ? { gatewayBudgetReservationId } : {}),
        },
      },
      ephemeralToken,
    );
    return sessionId;
  } catch (e) {
    gatewayDeps.logger('gateway.assessTextAuthorize.failed', { message: String(e) });
    if (gatewayBudgetReservationId) {
      await releaseSessionReservation(gatewayDeps, gatewayBudgetReservationId, 'assess_text_authorize_failed');
    }
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
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
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
    .select('id, metadata')
    .maybeSingle();

  if (error || !data) return null;
  return data as { id: string; metadata: Record<string, unknown> };
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
    // Lets reservation-reconciliation.ts's getSessionUsageEvents locate
    // this session's real events when reconciling the upfront budget
    // reservation (see reserveAssessTextBudget) — the same field
    // conversation.realtime_usage's events are keyed by.
    providerSessionRecordId: gatewaySessionId,
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

    await recordAssessTextUsageEvent(gatewayDeps, userId, gatewaySessionId, durationSeconds);

    // Reconcile the upfront budget reservation (if any) against the REAL
    // recorded cost — commits it into ai_gateway_budget_buckets.
    // committed_cost_usd (or releases it in full if, somehow, no real
    // event ended up recorded) instead of leaving it release-only, which
    // used to let the budget look fully available again after a session
    // ended despite real spend having occurred.
    const reservationId = extractGatewayBudgetReservationId(session.metadata);
    if (reservationId) {
      await reconcileSessionReservation(gatewayDeps, ASSESS_TEXT_FEATURE_KEY, reservationId, gatewaySessionId);
    }
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
    const session = await transitionAssessTextSession(userId, gatewaySessionId, { status: 'failed' });
    // No ai_usage_event is created here: unlike /complete, we cannot prove a
    // physical Azure call was actually attempted (the browser may call /fail
    // before ever reaching the Speech SDK step) — never invent an event.
    if (!session) return; // unknown/foreign/already-terminal — idempotent no-op

    // No physical call was ever proven to happen — release the full
    // reservation rather than reconcile (there is structurally nothing to
    // sum real cost from).
    const reservationId = extractGatewayBudgetReservationId(session.metadata);
    if (reservationId) {
      await releaseSessionReservation(gatewayDeps, reservationId, 'assess_text_failed');
    }
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
  const pronunciationConfigErrorCheck = checkFeatureConfigError(entitlements.pronunciation.evaluations);
  if (pronunciationConfigErrorCheck) {
    return res.status(500).json({ code: pronunciationConfigErrorCheck.code, message: pronunciationConfigErrorCheck.message });
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

  const compensateSlot = async (errorCode: string, errorMessage: string): Promise<void> => {
    if (!isOurSlot || !assessmentId) return;
    try {
      await supabase.rpc('compensate_pronunciation_assessment', { p_assessment_id: assessmentId, p_error_code: errorCode, p_error_message: errorMessage });
    } catch (compensateErr) {
      console.error('[pronunciation/start] Compensation RPC failed:', compensateErr instanceof Error ? compensateErr.message : 'unknown');
    }
  };

  // Upfront AI Gateway budget reservation for assess_text's real cost —
  // strictly BEFORE any Azure credential is minted. Fail-closed (see
  // reserveAssessTextBudget's header comment): a block or an infrastructure
  // failure both refuse to proceed, matching Conversation's own
  // reserveRealtimeSessionBudget. The server-authorized ceiling (never a
  // client-chosen duration) is what this is sized against — the /start
  // request body has no duration field to begin with.
  const estimatedAudioSeconds = estimateAudioSecondsCeiling(MAX_ASSESS_TEXT_DURATION_SECONDS);
  const budgetReservation = await reserveAssessTextBudget(gatewayDeps, auth.userId, estimatedAudioSeconds.quantity);
  if (!budgetReservation.allowed) {
    await compensateSlot('BUDGET_EXCEEDED', 'Orçamento configurado para o serviço de pronúncia foi atingido.');
    return res.status(403).json({
      code: 'BUDGET_EXCEEDED',
      message: 'O orçamento configurado para o serviço de pronúncia foi atingido. Tente novamente mais tarde.',
    });
  }
  const gatewayBudgetReservationId = budgetReservation.reservationId ?? undefined;

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
    // Token issuance failed AFTER the budget reservation succeeded — no
    // physical call to Azure was ever proven to happen, so release it
    // rather than leaving it held until it expires on its own.
    if (gatewayBudgetReservationId) {
      await releaseSessionReservation(gatewayDeps, gatewayBudgetReservationId, 'assess_text_token_issue_failed');
    }
    const errorCode = err instanceof AzureSpeechError ? err.code : 'TOKEN_ISSUE_FAILED';
    await compensateSlot(errorCode, 'Falha ao emitir credencial temporária de pronúncia.');
    if (err instanceof AzureSpeechError) {
      return res.status(AZURE_ERROR_STATUS[err.code] ?? 503).json({ configured: false, code: err.code, message: AZURE_ERROR_MESSAGES[err.code] ?? AZURE_ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE });
    }
    console.error('[pronunciation/start] Unexpected token error:', err instanceof Error ? err.message : 'unknown');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao preparar a análise.' });
  }

  // Additive, retrocompatible: always authorized now (see header comment
  // above authorizeAssessTextSession) — gatewaySessionId absent only if
  // authorization itself failed (fail-open for THIS step specifically; the
  // budget decision itself was already fail-closed above).
  const gatewaySessionId = await authorizeAssessTextSession(
    gatewayDeps,
    auth.userId,
    assessmentId,
    tokenResult.token,
    new Date(Date.now() + tokenResult.expiresInSeconds * 1000),
    estimatedAudioSeconds.quantity,
    gatewayBudgetReservationId,
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
  // is now issued by every /start call regardless of gatewayMode (see header
  // comment above maybeAuthorizeAssessTextSession).
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
