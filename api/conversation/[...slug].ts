import { createHash } from 'node:crypto';
import { requireAuth } from '../_auth';
import { ASSISTANT_NAME, REALTIME_VOICES, VOICE_PREVIEW_PHRASE, PACE_LABELS, BASE_DEFAULTS } from '../../src/lib/tutorPreferences';
import { buildTutorInstructionsWithContext, ConversationStartContext } from '../../src/lib/promptBuilder';
import type { AIPreferences } from '../../src/types';
import { methodGuard, sizeGuard, jsonError, PAYLOAD_LIMITS, TIMEOUTS, safeLog, resolveSlug } from '../_helpers';
import { applyRateLimit } from '../_rateLimit';
import {
  executeAiGatewayCall,
  getProductionDeps,
  getSharedServiceClient,
  authorizeProviderSession,
  reconcileEventCost,
  rebuildDailyBucketForEvent,
  DuplicateUsageEventError,
  evaluateKillSwitch,
  estimateTtsCharacters,
  estimateProviderRequests,
  estimateRealtimeSessionSeconds,
  reconcileSessionReservation,
  releaseSessionReservation,
} from '../_ai-gateway/index';
import type { GatewayUsageMetric, GatewayDeps } from '../_ai-gateway/index';
import { countTtsPlainTextCharacters } from '../_ai-gateway/tts-character-count';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { checkRecordingDuration, checkFeatureConfigError } from '../_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../../src/domain/entitlements/entitlement-messages';
import { getTodaySP } from '../../src/lib/timezone';
import { hangupAndPersist } from '../_realtime-hangup';
import { WEBRTC_CONNECT_FEATURE_KEY, REALTIME_MAX_SESSION_SECONDS } from '../_realtime-constants';
import { reserveRealtimeSessionBudget } from '../_realtime-budget';

// ─── isValidUuid — shared by the webrtc_connect bridge handlers below ────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ─── POST /api/conversation/preview ──────────────────────────────────────────

const TTS_URL = 'https://api.openai.com/v1/audio/speech';

const PREVIEW_SPEED: Record<AIPreferences['speechPace'], number> = {
  slow:    0.82,
  normal:  1.0,
  natural: 1.18,
};

// ── Gateway wiring — wraps only the physical OpenAI TTS fetch call ───────────

class PreviewTtsTimeoutError extends Error {
  constructor() { super('OpenAI preview TTS request timed out'); this.name = 'PreviewTtsTimeoutError'; }
}
class PreviewTtsNetworkError extends Error {
  constructor() { super('Could not reach OpenAI preview TTS'); this.name = 'PreviewTtsNetworkError'; }
}
class PreviewTtsHttpError extends Error {
  constructor(public readonly openaiStatus: number) {
    super(`OpenAI preview TTS returned HTTP ${openaiStatus}`);
    this.name = 'PreviewTtsHttpError';
  }
}

function buildPreviewTtsMetrics(characterCount: number): GatewayUsageMetric[] {
  return [
    {
      metricKey: 'provider_requests',
      unitType: 'request',
      quantity: 1,
      isBillable: false,
      measurementSource: 'provider_response',
    },
    {
      metricKey: 'tts_characters',
      unitType: 'character',
      quantity: characterCount,
      isBillable: true,
      // Deterministic code-point count of the exact plain-text `input` body
      // sent to OpenAI (no SSML wrapper for this endpoint) — computed from
      // the request, not confirmed by a usage field in OpenAI's response.
      measurementSource: 'request_body',
    },
  ];
}

async function handlePreview(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.PREVIEW)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({ code: 'OPENAI_NOT_CONFIGURED', message: 'Serviço não configurado.' });
  }

  const body = req.body ?? {};
  const voiceId = typeof body.voice === 'string' ? body.voice.trim() : '';
  const pace    = typeof body.pace  === 'string' ? body.pace as AIPreferences['speechPace'] : 'normal';

  if (!await applyRateLimit(res, userId, 'conversation-preview')) return;

  const voiceEntry = REALTIME_VOICES.find((v) => v.id === voiceId);
  if (!voiceEntry) {
    return res.status(400).json({ code: 'INVALID_VOICE', message: 'Voz inválida.' });
  }

  const previewVoice = voiceEntry.previewVoice;
  const speed        = PREVIEW_SPEED[pace] ?? 1.0;
  const paceLabel    = PACE_LABELS[pace]?.label ?? pace;

  const input = `${VOICE_PREVIEW_PHRASE} I'll be speaking at a ${paceLabel.toLowerCase()} pace during our practice.`;
  const characterCount = countTtsPlainTextCharacters(input);

  const gatewayDeps = getProductionDeps();
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await executeAiGatewayCall<ArrayBuffer>(
      {
        featureKey: 'conversation.preview_tts',
        provider: 'openai',
        service: 'audio.speech',
        model: 'tts-1',
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        technicalMetadata: { endpoint: 'conversation/preview', voiceId, pace },
        // Etapa 11 correction — the exact text is already known before the
        // call (built two lines above), so this is an EXACT count, not an
        // estimate — the same counter buildPreviewTtsMetrics() below uses to
        // record the real tts_characters metric after the call succeeds.
        estimatedMetrics: [estimateProviderRequests(1), estimateTtsCharacters(input, false)],
      },
      async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUTS.SHORT);
        let ttsRes: Response;
        try {
          ttsRes = await fetch(TTS_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'tts-1', voice: previewVoice, input, speed, response_format: 'mp3' }),
            signal: ctrl.signal,
          });
        } catch (err) {
          const isAbort = err instanceof Error && err.name === 'AbortError';
          throw isAbort ? new PreviewTtsTimeoutError() : new PreviewTtsNetworkError();
        } finally {
          clearTimeout(timer);
        }

        if (!ttsRes.ok) {
          throw new PreviewTtsHttpError(ttsRes.status);
        }

        return ttsRes.arrayBuffer();
      },
      gatewayDeps,
      () => buildPreviewTtsMetrics(characterCount),
    );
  } catch (err) {
    if (err instanceof PreviewTtsTimeoutError) {
      safeLog('conversation/preview', 'timeout', 504);
      return res.status(504).json({ code: 'AI_TIMEOUT', message: 'O serviço demorou para responder. Tente novamente.' });
    }
    if (err instanceof PreviewTtsNetworkError) {
      safeLog('conversation/preview', 'network_error', 502);
      return res.status(502).json({ code: 'PREVIEW_FAILED', message: 'Não foi possível gerar a amostra.' });
    }
    if (err instanceof PreviewTtsHttpError) {
      safeLog('conversation/preview', 'tts_error', err.openaiStatus);
      return res.status(502).json({ code: 'PREVIEW_FAILED', message: 'Não foi possível gerar a amostra.' });
    }
    throw err;
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from(audioBuffer));
}

// ─── POST /api/conversation/session ──────────────────────────────────────────

const REALTIME_MODEL =
  (process.env.OPENAI_REALTIME_MODEL ?? '').trim() || 'gpt-realtime-2.1-mini';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

// Etapa 11 — unified interface. Same endpoint the browser used to POST its
// SDP offer to directly; now this backend makes that call instead (see
// handleWebrtcConnect below).
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

// Server-authoritative Realtime session ceiling (Etapa 11, Fase 9). Same
// value the client already enforced itself via a hardcoded constant before
// this stage (src/hooks/useRealtimeSession.ts's old MAX_SESSION_MS) — moving
// it server-side changes nothing about today's behavior, it only lets
// /session-control (below) compute the same deadline independently of
// client-side JS, and gives a single place to change it later. Imported
// (not declared here) from api/_realtime-constants.ts — the sweep job in
// api/internal/listening/[...slug].ts's conversation-sweep route needs the
// exact same value.

const SESSION_ERROR_STATUS: Record<string, number> = {
  OPENAI_INVALID_SESSION: 400,
  OPENAI_AUTH_FAILED:     401,
  OPENAI_RATE_LIMITED:    429,
  OPENAI_UNAVAILABLE:     502,
  OPENAI_SESSION_FAILED:  502,
};

const SESSION_ERROR_MESSAGE: Record<string, string> = {
  OPENAI_INVALID_SESSION: 'A configuração da conversa precisa ser corrigida.',
  OPENAI_AUTH_FAILED:     'A chave da OpenAI não foi aceita.',
  OPENAI_RATE_LIMITED:    'O limite de uso da conversa foi atingido. Verifique o saldo da OpenAI.',
  OPENAI_UNAVAILABLE:     'O serviço de conversa está indisponível no momento.',
  OPENAI_SESSION_FAILED:  'Não foi possível criar a sessão de conversa.',
};

function getTodayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

function extractMission(snapshot: unknown): { title: string; description: string; requiredWords: string[] } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const r = snapshot as Record<string, unknown>;
  if (typeof r.missionTitle === 'string') {
    return {
      title: r.missionTitle,
      description: String(r.missionPromptPt ?? r.missionPromptEn ?? r.missionTask ?? ''),
      requiredWords: Array.isArray(r.missionRequiredWords) ? (r.missionRequiredWords as string[]) : [],
    };
  }
  if (typeof r.title === 'string') {
    return {
      title: r.title,
      description: String(r.mission ?? r.themePtBr ?? r.themeEn ?? ''),
      requiredWords: [
        ...(Array.isArray(r.useTheseWords) ? (r.useTheseWords as string[]) : []),
        ...(Array.isArray(r.requiredWords) ? (r.requiredWords as string[]) : []),
      ],
    };
  }
  return null;
}

function mapOpenAIStatus(status: number): string {
  if (status === 400) return 'OPENAI_INVALID_SESSION';
  if (status === 401 || status === 403) return 'OPENAI_AUTH_FAILED';
  if (status === 429) return 'OPENAI_RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'OPENAI_UNAVAILABLE';
  return 'OPENAI_SESSION_FAILED';
}

// ── Gateway wiring — wraps only the physical client_secrets fetch call ───────

class CreateSessionTimeoutError extends Error {
  constructor() { super('OpenAI realtime/client_secrets request timed out'); this.name = 'CreateSessionTimeoutError'; }
}
class CreateSessionNetworkError extends Error {
  constructor() { super('Could not reach OpenAI realtime/client_secrets'); this.name = 'CreateSessionNetworkError'; }
}
class CreateSessionHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly rawText: string,
    public readonly requestId: string | null,
  ) {
    super(`OpenAI realtime/client_secrets returned HTTP ${httpStatus}`);
    this.name = 'CreateSessionHttpError';
  }
  // Read by api/_ai-gateway/sanitize.ts:sanitizeError() to populate the
  // failed event's http_status without needing to touch the raw body.
  get status(): number { return this.httpStatus; }
}

function buildCreateSessionMetrics(): GatewayUsageMetric[] {
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

// The session's own feature_key is conversation.webrtc_connect (the frontend
// feature that will actually report activation/usage/completion), even
// though it is authorized here — the same split used by
// pronunciation.start_assessment authorizing a pronunciation.assess_text
// session (see api/pronunciation/[...slug].ts).
//
// Correction: this used to be gated on conversation.webrtc_connect's own
// gatewayMode === 'observe' — but the physical WebRTC call (and the real
// cost conversation.realtime_usage later attaches to this session) happens
// unconditionally, in every mode, since it is driven entirely by the
// browser regardless of what this backend's runtime policy says. Gating
// authorization on gatewayMode meant the mode controlled whether telemetry
// existed at all, not just how the Gateway enforces — exactly backwards
// (mode must never decide whether cost gets recorded, only how the Gateway
// enforces). This bridge now always authorizes a session and always records
// usage, in legacy, observe, and enforce alike — the same fix already
// applied to pronunciation.assess_text's bridge (see the header comment
// above maybeAuthorizeAssessTextSession in api/pronunciation/[...slug].ts).
async function maybeAuthorizeWebrtcSession(
  gatewayDeps: GatewayDeps,
  userId: string,
  ephemeralToken: string,
  expiresAt: Date,
): Promise<string | undefined> {
  try {
    const { sessionId } = await authorizeProviderSession(
      gatewayDeps.usageRepository,
      {
        featureKey: 'conversation.webrtc_connect',
        provider: 'openai',
        userId,
        initiatedByUserId: userId,
        internalSessionType: 'conversation_realtime',
        authorizationExpiresAt: expiresAt,
        // Technical only — REALTIME_MODEL is read back server-side when
        // resolving cost for relayed usage events; never trust the client.
        metadata: { endpoint: 'conversation/session', model: REALTIME_MODEL },
      },
      ephemeralToken,
    );
    return sessionId;
  } catch (e) {
    gatewayDeps.logger('gateway.webrtcConnectAuthorize.failed', { message: String(e) });
    return undefined; // fail-open: token issuance must never be blocked by this
  }
}

function rowToPrefs(row: Record<string, unknown>): AIPreferences {
  return {
    // Identity is fixed — never trust the stored value. This is what feeds the
    // realtime voice system prompt, so it must never resolve to a stale/legacy
    // name (e.g. "Alex") even if the DB row hasn't been migrated yet.
    teacherName:        ASSISTANT_NAME,
    voice:              String(row.voice               ?? BASE_DEFAULTS.voice),
    accent:             (row.accent              as AIPreferences['accent'])            ?? BASE_DEFAULTS.accent,
    speechPace:         (row.speech_pace         as AIPreferences['speechPace'])        ?? BASE_DEFAULTS.speechPace,
    personalityPreset:  (row.personality_preset  as AIPreferences['personalityPreset']) ?? BASE_DEFAULTS.personalityPreset,
    formality:          (row.formality           as AIPreferences['formality'])          ?? BASE_DEFAULTS.formality,
    humorLevel:         (row.humor_level         as AIPreferences['humorLevel'])         ?? BASE_DEFAULTS.humorLevel,
    roastIntensity:     (row.roast_intensity     as AIPreferences['roastIntensity'])     ?? BASE_DEFAULTS.roastIntensity,
    profanityEnabled:   typeof row.profanity_enabled === 'boolean' ? row.profanity_enabled : BASE_DEFAULTS.profanityEnabled,
    topicInitiative:    (row.topic_initiative    as AIPreferences['topicInitiative'])    ?? BASE_DEFAULTS.topicInitiative,
    correctionTiming:   (row.correction_timing   as AIPreferences['correctionTiming'])   ?? BASE_DEFAULTS.correctionTiming,
    correctionScope:    (row.correction_scope    as AIPreferences['correctionScope'])    ?? BASE_DEFAULTS.correctionScope,
    correctionLanguage: (row.correction_language as AIPreferences['correctionLanguage']) ?? BASE_DEFAULTS.correctionLanguage,
    correctionDetail:   (row.correction_detail   as AIPreferences['correctionDetail'])   ?? BASE_DEFAULTS.correctionDetail,
    focusAreas:         Array.isArray(row.focus_areas) ? (row.focus_areas as string[]) : BASE_DEFAULTS.focusAreas,
    dailyConversationGoalMinutes: (row.daily_conversation_goal_minutes as number | null) ?? BASE_DEFAULTS.dailyConversationGoalMinutes,
  };
}

async function handleSession(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.CONVERSATION)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase, userId } = auth;

  const openaiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!openaiKey) {
    return res.status(503).json({ code: 'OPENAI_NOT_CONFIGURED', message: 'O serviço de conversa não está configurado.' });
  }

  // ── Plan entitlements ──────────────────────────────────────────────────────
  // Gates creating a NEW realtime session (the costly operation). Distinct
  // from prefs.dailyConversationGoalMinutes below, which is the user's own
  // practice goal (untouched, always preserved) — this is the commercial
  // monthly quota + extra purchased credits.
  let entitlements;
  try {
    entitlements = await getCurrentUserPlanEntitlements(userId);
  } catch {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Não foi possível verificar seu plano. Tente novamente.' });
  }
  const conversationConfigErrorCheck = checkFeatureConfigError(entitlements.conversation.monthlyTime);
  if (conversationConfigErrorCheck) {
    return res.status(500).json({ code: conversationConfigErrorCheck.code, message: conversationConfigErrorCheck.message });
  }
  if (!entitlements.conversation.enabled) {
    return res.status(403).json({ code: 'FEATURE_DISABLED', message: ENTITLEMENT_MESSAGES.conversationUnavailable });
  }
  if (!entitlements.conversation.monthlyTime.canStart) {
    return res.status(403).json({ code: 'MONTHLY_LIMIT_REACHED', message: ENTITLEMENT_MESSAGES.conversationMinutesExhausted });
  }

  // Fase 12 — authorized max recording time for the call about to start:
  // the smallest positive value among the per-recording commercial cap, the
  // remaining monthly balance (extra credits included), and the technical
  // session ceiling. Computed HERE (a cheap, pure calculation, no I/O) so
  // the upfront Gateway budget reservation below — after the rate limiter,
  // before ever calling OpenAI — can size itself against the real ceiling
  // this session would actually be authorized to use. Reused unchanged
  // later in this function for the response fields — never recomputed
  // against a slightly different "now".
  const gatewayDeps = getProductionDeps();
  const sessionStartNowMs = gatewayDeps.clock();
  const authorizedAtStart = computeAuthorizedRecording(
    entitlements, sessionStartNowMs, sessionStartNowMs + REALTIME_MAX_SESSION_SECONDS * 1000,
  );

  const safetyIdentifier = createHash('sha256').update(userId).digest('hex');
  const today = getTodayUtc();

  let prefs: AIPreferences = { ...BASE_DEFAULTS };
  let cefrLevel = 'A1';
  let ctx: ConversationStartContext = {
    theme: null,
    missionTitle: null,
    missionDescription: null,
    studentText: null,
    version2: null,
    mandatoryWords: [],
    recentMistakes: [],
    currentGrammarObjectives: [],
    conversationGoalMinutes: BASE_DEFAULTS.dailyConversationGoalMinutes,
    remainingConversationMinutes: 0,
  };

  try {
    const [prefsResult, memoryResult, todayReviewResult, recentReviewsResult, convTotalResult] = await Promise.all([
      supabase.from('ai_conversation_preferences').select('*').maybeSingle(),
      supabase.from('english_learning_memory').select('current_level').order('updated_at', { ascending: false }).limit(1),
      supabase.from('english_reviews').select('original_text,version_2_text,main_mistakes,mission_snapshot').eq('entry_date', today).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('english_reviews').select('main_mistakes,objective,next_practice').order('created_at', { ascending: false }).limit(5),
      supabase.from('conversation_sessions').select('duration_sec').eq('session_date', today),
    ]);

    if (prefsResult.data) prefs = rowToPrefs(prefsResult.data as Record<string, unknown>);
    const memRow = memoryResult.data?.[0] as { current_level?: string } | undefined;
    if (memRow?.current_level) cefrLevel = memRow.current_level;

    ctx.conversationGoalMinutes = prefs.dailyConversationGoalMinutes;

    if (todayReviewResult.data) {
      const r = todayReviewResult.data as Record<string, unknown>;
      ctx.studentText = r.original_text ? String(r.original_text) : null;
      ctx.version2    = r.version_2_text ? String(r.version_2_text) : null;
      const mission = extractMission(r.mission_snapshot);
      if (mission) {
        ctx.missionTitle       = mission.title;
        ctx.missionDescription = mission.description || null;
        ctx.mandatoryWords     = mission.requiredWords;
      }
    }

    const reviewRows = (recentReviewsResult.data ?? []) as Record<string, unknown>[];
    const seenMistakes = new Set<string>();
    const seenObjectives = new Set<string>();
    for (const r of reviewRows) {
      for (const m of Array.isArray(r.main_mistakes) ? (r.main_mistakes as Record<string, string>[]) : []) {
        const key = (m.original ?? '').trim().toLowerCase();
        if (!key || seenMistakes.has(key)) continue;
        seenMistakes.add(key);
        ctx.recentMistakes.push(`${m.original} → ${m.correct}: ${m.explanation}`);
        if (ctx.recentMistakes.length >= 5) break;
      }
      const obj = r.objective ? String(r.objective).trim() : '';
      if (obj && !seenObjectives.has(obj)) {
        seenObjectives.add(obj);
        ctx.currentGrammarObjectives.push(obj);
      }
      if (ctx.recentMistakes.length >= 5 && ctx.currentGrammarObjectives.length >= 3) break;
    }
    ctx.currentGrammarObjectives = ctx.currentGrammarObjectives.slice(0, 3);

    const totalConvSec = ((convTotalResult.data ?? []) as Record<string, number>[])
      .reduce((sum, row) => sum + (row.duration_sec ?? 0), 0);
    const totalConvMin = Math.floor(totalConvSec / 60);
    ctx.remainingConversationMinutes = Math.max(0, prefs.dailyConversationGoalMinutes - totalConvMin);
  } catch {
    // context is optional
  }

  if (!await applyRateLimit(res, userId, 'conversation-session')) return;

  // Upfront AI Gateway budget reservation for conversation.realtime_usage —
  // see api/_realtime-budget.ts's header comment for the full rationale.
  // After the rate limiter (a spamming client must not be able to hold
  // budget capacity via repeated never-completed reservations faster than
  // it can be rate-limited), but still strictly before the OpenAI call
  // below: refuses to ever mint an ephemeral token when the session's own
  // worst-case cost already cannot be proven to fit in the remaining
  // configured budget. A no-op (always allowed, no reservation held) when
  // no budget is configured anywhere for this scope — matches today's
  // production reality.
  const realtimeBudget = await reserveRealtimeSessionBudget(
    gatewayDeps, userId, 'openai', REALTIME_MODEL, authorizedAtStart.authorizedMaxRecordingSeconds,
  );
  if (!realtimeBudget.allowed) {
    return res.status(403).json({
      code: 'BUDGET_EXCEEDED',
      message: 'O orçamento configurado para o serviço de conversa foi atingido. Tente novamente mais tarde.',
    });
  }

  const instructions = buildTutorInstructionsWithContext(prefs, cefrLevel, ctx);
  if (!instructions) {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao preparar a sessão.' });
  }

  const sessionConfig = {
    expires_after: { anchor: 'created_at', seconds: 120 },
    session: {
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions,
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 2500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: prefs.voice },
      },
    },
  };

  let rawText: string;
  try {
    const fetchResult = await executeAiGatewayCall<{ httpStatus: number; requestId: string | null; rawText: string }>(
      {
        featureKey: 'conversation.create_session',
        provider: 'openai',
        service: 'realtime.client_secrets',
        model: REALTIME_MODEL,
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId: gatewayDeps.uuidGen(),
        attemptNumber: 1,
        callSequence: 1,
        technicalMetadata: { endpoint: 'conversation/session', model: REALTIME_MODEL },
      },
      async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUTS.SHORT);
        let openaiRes: Response;
        try {
          openaiRes = await fetch(CLIENT_SECRETS_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              'Content-Type': 'application/json',
              'OpenAI-Safety-Identifier': safetyIdentifier,
            },
            body: JSON.stringify(sessionConfig),
            signal: ctrl.signal,
          });
        } catch (err) {
          const isAbort = err instanceof Error && err.name === 'AbortError';
          throw isAbort ? new CreateSessionTimeoutError() : new CreateSessionNetworkError();
        } finally {
          clearTimeout(timer);
        }

        const fetchedStatus = openaiRes.status;
        const fetchedRequestId = openaiRes.headers.get('x-request-id');
        const fetchedRawText = await openaiRes.text();

        if (fetchedStatus < 200 || fetchedStatus >= 300) {
          throw new CreateSessionHttpError(fetchedStatus, fetchedRawText, fetchedRequestId);
        }
        return { httpStatus: fetchedStatus, requestId: fetchedRequestId, rawText: fetchedRawText };
      },
      gatewayDeps,
      buildCreateSessionMetrics,
    );
    rawText = fetchResult.rawText;
  } catch (err) {
    // The OpenAI call never succeeded — this session never really started,
    // so the upfront budget hold (if any) must be released rather than
    // sitting reserved for up to REALTIME_MAX_SESSION_SECONDS over a call
    // that never happened.
    if (realtimeBudget.reservationId) await releaseSessionReservation(gatewayDeps, realtimeBudget.reservationId, 'session_never_started');
    if (err instanceof CreateSessionTimeoutError) {
      safeLog('conversation/session', 'timeout', 504);
      return res.status(504).json({ code: 'AI_TIMEOUT', message: 'O serviço demorou para responder. Tente novamente.' });
    }
    if (err instanceof CreateSessionNetworkError) {
      safeLog('conversation/session', 'network_error', 502);
      return res.status(502).json({ code: 'OPENAI_UNREACHABLE', message: 'Não foi possível conectar ao serviço de IA.' });
    }
    if (err instanceof CreateSessionHttpError) {
      const errorCode = mapOpenAIStatus(err.httpStatus);
      let parsed: { error?: { type?: string; code?: string; param?: string; message?: string } } = {};
      try { parsed = JSON.parse(err.rawText); } catch { /* ok */ }
      const e = parsed.error ?? {};
      safeLog('conversation/session', 'openai_error', SESSION_ERROR_STATUS[errorCode] ?? 502, {
        httpStatus: err.httpStatus, requestId: err.requestId,
        type: typeof e.type === 'string' ? e.type : null,
        code: typeof e.code === 'string' ? e.code : null,
      });
      return res.status(SESSION_ERROR_STATUS[errorCode] ?? 502)
        .json({ code: errorCode, message: SESSION_ERROR_MESSAGE[errorCode] });
    }
    throw err;
  }

  let data: { value?: unknown; expires_at?: unknown; session?: { id?: string; model?: string } };
  try { data = JSON.parse(rawText); }
  catch {
    console.error('[conversation/session] Failed to parse OpenAI response');
    return res.status(502).json({ code: 'OPENAI_SESSION_FAILED', message: SESSION_ERROR_MESSAGE.OPENAI_SESSION_FAILED });
  }

  if (typeof data.value !== 'string' || !data.value) {
    console.error('[conversation/session] GA response missing value field');
    return res.status(502).json({ code: 'OPENAI_SESSION_FAILED', message: SESSION_ERROR_MESSAGE.OPENAI_SESSION_FAILED });
  }
  if (typeof data.expires_at !== 'number') {
    console.error('[conversation/session] GA response missing expires_at');
    return res.status(502).json({ code: 'OPENAI_SESSION_FAILED', message: SESSION_ERROR_MESSAGE.OPENAI_SESSION_FAILED });
  }

  // Additive, retrocompatible: gatewaySessionId is now always authorized,
  // independent of gatewayMode (see the correction comment above
  // maybeAuthorizeWebrtcSession) — absent only if authorization itself
  // failed. Never blocks token issuance on failure (fail-open, isolated
  // inside maybeAuthorizeWebrtcSession).
  const gatewaySessionId = await maybeAuthorizeWebrtcSession(
    gatewayDeps,
    userId,
    data.value,
    new Date(data.expires_at * 1000),
  );

  // authorizedAtStart was already computed above (before the budget
  // reservation and the OpenAI call) — reused here unchanged. The frontend
  // uses these fields purely for UX (countdown, auto-stop) — enforcement
  // itself stays server-side via session-control.

  // Quota-bypass fix (2026-07-21 audit) — a server-only authorization row,
  // independent of conversation.webrtc_connect's (still 'legacy') AI Gateway
  // observe mode. session-complete below closes it and computes the
  // authoritative duration itself from authorized_at — never from a
  // client-supplied number — before mirroring it into conversation_sessions,
  // the table plan-entitlements-service.ts sums for monthlyTime.consumed.
  // Best-effort: a failure here must never block issuing the token the
  // student is waiting for; it just means this call's duration silently
  // won't count toward their quota (same direction of failure as before this
  // fix existed, never worse).
  let recordingAuthorizationId: string | null = null;
  const authorizedMaxSecondsFloor = Math.floor(authorizedAtStart.authorizedMaxRecordingSeconds);
  if (authorizedMaxSecondsFloor > 0) {
    try {
      const { data: authRow, error: authErr } = await getSharedServiceClient()
        .from('conversation_session_authorizations')
        .insert({
          user_id: userId,
          session_date: getTodaySP(),
          authorized_max_seconds: authorizedMaxSecondsFloor,
          // Reconciled (committed with the session's real cost, or released
          // if no usage occurred) by /session-complete below, or by the
          // abandoned-session sweep — see
          // api/_ai-gateway/reservation-reconciliation.ts. NULL when no
          // budget was configured for conversation.realtime_usage at
          // session-start time.
          gateway_budget_reservation_id: realtimeBudget.reservationId,
          // conversation.realtime_usage's real ai_usage_events are keyed by
          // THIS id (ai_provider_sessions.id, not this row's own id) —
          // required to look them up when reconciling the reservation above.
          gateway_session_id: gatewaySessionId ?? null,
        })
        .select('id')
        .single();
      if (!authErr && authRow) recordingAuthorizationId = (authRow as { id: string }).id;
    } catch (e) {
      gatewayDeps.logger('gateway.conversationSessionAuthorization.failed', { message: String(e) });
    }
  }
  if (!recordingAuthorizationId && realtimeBudget.reservationId) {
    // The authorization row itself failed to insert (best-effort, logged
    // above) — nothing will ever call /session-complete for a row that
    // doesn't exist, so this reservation would otherwise sit held until its
    // REALTIME_MAX_SESSION_SECONDS expiry. Release it now rather than leak
    // it silently.
    await releaseSessionReservation(gatewayDeps, realtimeBudget.reservationId, 'authorization_row_insert_failed');
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    token:     data.value,
    sessionId: data.session?.id ?? null,
    model:     data.session?.model ?? REALTIME_MODEL,
    voice:     prefs.voice,
    expiresAt: data.expires_at,
    // Additive (Etapa 11, Fase 9) — always present, independent of
    // gatewaySessionId/observe mode, so the client can always source its
    // self-termination timer from the server instead of a hardcoded
    // constant. Older cached frontend bundles that don't read this field
    // simply keep using their own hardcoded value — no breaking change.
    maxSessionSeconds: REALTIME_MAX_SESSION_SECONDS,
    // Fase 12 — commercial-aware authorized recording time (see comment
    // above). Never inferred client-side.
    authorizedMaxRecordingSeconds: authorizedAtStart.authorizedMaxRecordingSeconds,
    recordingLimitReason: authorizedAtStart.recordingLimitReason,
    // Present whenever the authorization row above was written — the client
    // must send this (unchanged) back to /session-complete when the call
    // ends so the server can compute and record the real duration. Absent
    // (older cached bundle, or the best-effort insert above failed) simply
    // means this call's time is never credited toward monthlyTime.consumed.
    ...(recordingAuthorizationId ? { recordingAuthorizationId } : {}),
    ...(gatewaySessionId ? { gatewaySessionId } : {}),
  });
}

// ── /session-complete ───────────────────────────────────────────────────────
// Closes a conversation_session_authorizations row opened by handleSession
// above and mirrors the authoritative duration into conversation_sessions
// (read by getDayTotalSeconds/getMonthSessionTotals for the calendar/daily
// goal UI, and by plan-entitlements-service.ts for the monthly quota).
// duration_seconds is always computed here from server clocks
// (now - authorized_at, clamped to authorized_max_seconds) — the client
// supplies only the authorization id, never a duration. Idempotent by the
// same guarded-UPDATE pattern as handleSessionEnd: a second call for an
// already-'completed' row matches no rows and is a no-op.
async function handleSessionComplete(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.CONVERSATION)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const recordingAuthorizationId = (req.body ?? {}).recordingAuthorizationId;
  if (!isValidUuid(recordingAuthorizationId)) {
    return jsonError(res, 400, 'INVALID_RECORDING_AUTHORIZATION_ID', 'recordingAuthorizationId inválido.');
  }

  try {
    const gatewayDeps = getProductionDeps();
    const nowMs = gatewayDeps.clock();
    const client = getSharedServiceClient();
    const { data: authRow, error: fetchErr } = await client
      .from('conversation_session_authorizations')
      .select('id, session_date, authorized_at, authorized_max_seconds, gateway_budget_reservation_id, gateway_session_id')
      .eq('id', recordingAuthorizationId)
      .eq('user_id', userId)
      .eq('status', 'authorized')
      .maybeSingle();

    if (fetchErr || !authRow) {
      // Foreign, already completed, or never created — idempotent no-op.
      return res.status(200).json({ status: 'ignored' });
    }

    const row = authRow as {
      id: string; session_date: string; authorized_at: string; authorized_max_seconds: number;
      gateway_budget_reservation_id: string | null; gateway_session_id: string | null;
    };
    const elapsedSeconds = (nowMs - new Date(row.authorized_at).getTime()) / 1000;
    const durationSeconds = Math.floor(Math.max(0, Math.min(elapsedSeconds, row.authorized_max_seconds)));

    // Status guard again on the UPDATE itself — the single source of atomicity:
    // if two requests race, only the first one's WHERE clause matches any rows.
    const { data: updated } = await client
      .from('conversation_session_authorizations')
      .update({ status: 'completed', completed_at: new Date(nowMs).toISOString(), duration_seconds: durationSeconds })
      .eq('id', row.id)
      .eq('status', 'authorized')
      .select('id')
      .maybeSingle();

    if (!updated) return res.status(200).json({ status: 'ignored' });

    // Reconcile the upfront conversation.realtime_usage budget reservation
    // against the session's REAL recorded cost — commits it into
    // ai_gateway_budget_buckets.committed_cost_usd (or releases it in full
    // if the session recorded no real usage at all) — now that the session
    // has genuinely ended. Only on the branch that actually won the atomic
    // UPDATE above, so a racing duplicate /session-complete call never
    // double-reconciles (commit_gateway_reservation_v1/
    // release_gateway_reservation_v1 are independently idempotent too).
    if (row.gateway_budget_reservation_id && row.gateway_session_id) {
      await reconcileSessionReservation(gatewayDeps, 'conversation.realtime_usage', row.gateway_budget_reservation_id, row.gateway_session_id);
    } else if (row.gateway_budget_reservation_id) {
      // No webrtc_connect bridge session was ever authorized (fail-open
      // path — see maybeAuthorizeWebrtcSession) so there is structurally no
      // ai_usage_events row this reservation could ever be reconciled
      // against — release it rather than hold it forever.
      await releaseSessionReservation(gatewayDeps, row.gateway_budget_reservation_id, 'no_gateway_session_to_reconcile_against');
    }

    // conversation_sessions.duration_sec has CHECK (duration_sec > 0) — a
    // call that never really got going (mic granted, connection dropped in
    // under a second) simply never produces a calendar/quota row, matching
    // the pre-fix client behavior of skipping sub-10s sessions as noise.
    if (durationSeconds > 0) {
      const { error: insertErr } = await client
        .from('conversation_sessions')
        .insert({ user_id: userId, session_date: row.session_date, duration_sec: durationSeconds });
      if (insertErr) {
        console.error('[conversation/session-complete] failed to mirror duration', insertErr.message);
      }
    }

    return res.status(200).json({ status: 'completed', durationSeconds });
  } catch (e) {
    console.error('[conversation/session-complete] failed', e instanceof Error ? e.message : 'unknown');
    return res.status(200).json({ status: 'ignored' }); // fail-open — never surfaced to the student
  }
}

// ─── POST /api/conversation/session-{active,failed,usage,end} ───────────────
// Authenticated bridge for conversation.webrtc_connect. The physical WebRTC
// POST to https://api.openai.com/v1/realtime/calls happens entirely in the
// browser (src/hooks/useRealtimeSession.ts) and cannot be wrapped by a
// server-only function, so ai_provider_sessions (authorized above, in
// maybeAuthorizeWebrtcSession) is the authenticated bridge: the browser
// reports connection outcome/usage/completion here, and every report is
// re-validated server-side (ownership, feature, provider, status,
// expiration) via an atomic UPDATE ... WHERE status IN (...) — never
// trusting the client's claim beyond "which row to look up." Same pattern
// as pronunciation.assess_text's /complete and /fail bridge in
// api/pronunciation/[...slug].ts.
//
// Single-segment slugs (session-active, not session/active): a nested
// sub-path 404'd in production — Vercel never routed the extra path segment
// into this function at all (confirmed by real HTTP 404s with
// gatewaySessionId present and requireAuth never reached), even though a
// hand-built req.query.slug array in tests made the dispatcher itself look
// correct. 'preview' and 'session' above are flat and already deploy
// correctly, so every bridge route uses that same proven shape.
//
// All four handlers are fire-and-forget from the browser's perspective
// (src/lib/realtimeGatewayReporting.ts never awaits their body) and always
// resolve 200 on the telemetry path — a duplicate/foreign/expired/malformed
// report is an idempotent no-op, and an internal telemetry failure is
// caught and logged, never surfaced to the student.
//
// Grain: conversation.webrtc_connect records AT MOST ONE ai_usage_event per
// physical POST to /v1/realtime/calls — one event for that connection
// attempt's entire lifecycle, never one-per-endpoint-call. session-active
// creates it (status='succeeded', provider_requests=1) or session-failed
// creates it (status='failed', no metrics — a failure before the physical
// call was ever attempted must never fabricate provider_requests).
// session-end never creates a second event: it locates the SAME event by
// (provider_session_record_id, feature_key, status='succeeded') and attaches
// session_seconds to it, then rebuilds that event's daily bucket — it never
// invents a replacement event if the original cannot be found. All three
// share the session id as correlationId. conversation.realtime_usage (the
// separate billing key) records one incremental event per Realtime
// response.done, via session-usage, deduplicated by
// (provider_session_record_id, provider_request_id = response.id).

// WEBRTC_CONNECT_FEATURE_KEY imported (not declared here) — see the comment
// on REALTIME_MAX_SESSION_SECONDS's import above.
const REALTIME_USAGE_FEATURE_KEY = 'conversation.realtime_usage';

const ALLOWED_END_REASONS = new Set([
  'user_ended', 'dc_closed', 'max_duration_reached', 'unmounted',
  'connection_lost', 'webrtc_failed', 'webrtc_network', 'session_error', 'unknown',
]);

// Matches the OpenAI Realtime response id format loosely (e.g. "resp_...")
// without overfitting to a specific prefix that may change — just a safe,
// bounded technical identifier charset.
const PROVIDER_RESPONSE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function sessionsClient() {
  return getSharedServiceClient();
}

// ── /webrtc-connect ──────────────────────────────────────────────────────
// Etapa 11 — unified interface for WebRTC signaling. Previously
// (useRealtimeSession.ts, Step 5) the BROWSER posted its SDP offer directly
// to REALTIME_CALLS_URL with the ephemeral token, and this app's only
// chance to learn the OpenAI call_id was reading the response's `Location`
// header client-side — which only works if OpenAI exposes that header via
// CORS `Access-Control-Expose-Headers`, never verified live (see the old
// extractCallId doc comment in that file, now removed). This endpoint
// relays the SAME authenticated POST (same ephemeral token, same body,
// same OpenAI endpoint) from the BACKEND instead: a server-to-server fetch
// has no CORS restriction on which response headers it can read, so
// call_id is now captured reliably on every call, every time, with no
// dependency on browser/CORS behavior at all.
//
// Trust model unchanged from before this endpoint existed: still the
// short-lived ephemeral token minted by /session (never the real,
// long-lived OPENAI_API_KEY) that authenticates this specific call — this
// endpoint does not elevate what a compromised/expired token could do, it
// only changes WHO makes the HTTP request. The token arrives in the
// request body, is used exactly once, synchronously, in this function, and
// is never logged or persisted (same rule as provider-sessions.ts's
// fingerprint-only persistence of ephemeral tokens elsewhere in this
// module).
//
// call_id is persisted immediately (best-effort — a failure here never
// blocks returning the SDP answer the browser is waiting on to complete
// the handshake) rather than waiting for /session-active as before: a call
// that negotiates SDP successfully but then fails ICE before the data
// channel opens now still has a captured call_id available for cleanup
// (see the sweep job in api/internal/conversation/sweep.ts), which the old
// client-reported-at-session-active path could never provide for that
// scenario.
function extractCallIdFromLocation(locationHeader: string | null): string | null {
  if (!locationHeader) return null;
  const lastSegment = locationHeader.split('/').filter(Boolean).pop();
  return lastSegment && PROVIDER_RESPONSE_ID_RE.test(lastSegment) ? lastSegment : null;
}

async function handleWebrtcConnect(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.WEBRTC_SDP)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const body = req.body ?? {};
  const sdp = typeof body.sdp === 'string' ? body.sdp : null;
  const ephemeralToken = typeof body.ephemeralToken === 'string' ? body.ephemeralToken : null;
  const gatewaySessionId = typeof body.gatewaySessionId === 'string' ? body.gatewaySessionId : null;

  if (!sdp) {
    return jsonError(res, 400, 'INVALID_SDP', 'Oferta SDP inválida.');
  }
  if (!ephemeralToken) {
    return jsonError(res, 400, 'MISSING_EPHEMERAL_TOKEN', 'Token de sessão ausente.');
  }
  if (gatewaySessionId !== null && !isValidUuid(gatewaySessionId)) {
    return jsonError(res, 400, 'INVALID_GATEWAY_SESSION_ID', 'gatewaySessionId inválido.');
  }

  let openaiRes: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUTS.SHORT);
    try {
      openaiRes = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ephemeralToken}`,
          'Content-Type': 'application/sdp',
        },
        body: sdp,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return jsonError(res, 502, 'WEBRTC_NETWORK', 'Erro de rede ao conectar ao serviço de IA.');
  }

  if (!openaiRes.ok) {
    const errText = await openaiRes.text().catch(() => '');
    console.error('[conversation/webrtc-connect] /calls failed', { status: openaiRes.status, body: errText.slice(0, 200) });
    return jsonError(res, 502, 'WEBRTC_FAILED', 'Falha na conexão com o serviço de IA. Tente novamente.');
  }

  // Server-to-server read — always reliable, no CORS exposure required.
  const callId = extractCallIdFromLocation(openaiRes.headers.get('Location'));
  const answerSdp = await openaiRes.text();
  if (!answerSdp) {
    return jsonError(res, 502, 'WEBRTC_FAILED', 'Resposta SDP vazia recebida do serviço de IA.');
  }

  if (callId && gatewaySessionId) {
    try {
      await sessionsClient()
        .from('ai_provider_sessions')
        .update({ provider_session_id: callId })
        .eq('id', gatewaySessionId)
        .eq('user_id', userId)
        .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
        .eq('provider', 'openai')
        .in('status', ['authorized', 'connecting', 'active']);
    } catch (e) {
      // Best-effort — the SDP answer below is still returned regardless;
      // worst case this call simply has no server-side hangup capability
      // later, same degraded-but-working posture as before this endpoint.
      console.error('[conversation/webrtc-connect] failed to persist call_id', e instanceof Error ? e.message : 'unknown');
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ sdp: answerSdp });
}

// ── /active ───────────────────────────────────────────────────────────────

async function handleSessionActive(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const body = req.body ?? {};
  const gatewaySessionId = body.gatewaySessionId;
  if (!isValidUuid(gatewaySessionId)) {
    return jsonError(res, 400, 'INVALID_GATEWAY_SESSION_ID', 'gatewaySessionId inválido.');
  }
  // call_id is now captured server-side and persisted synchronously by
  // handleWebrtcConnect above, before this handler ever runs — this
  // client-reported fallback only still matters for an older cached
  // frontend bundle that predates the unified interface (still POSTs
  // straight to OpenAI and reads Location itself, best-effort). The
  // guarded UPDATE below only overwrites provider_session_id when callId is
  // present, so on a current bundle (callId always absent — the field was
  // removed from the client payload) it never clobbers what
  // handleWebrtcConnect already wrote.
  const callId = typeof body.callId === 'string' && PROVIDER_RESPONSE_ID_RE.test(body.callId) ? body.callId : null;

  try {
    const gatewayDeps = getProductionDeps();
    // Server-controlled clock — never the client's. This is the single
    // authoritative "session started" instant: session-end later computes
    // session_seconds as (server ended_at − this started_at), never from a
    // client-reported duration.
    const startedAtMs = gatewayDeps.clock();
    const nowIso = new Date(startedAtMs).toISOString();
    // last_heartbeat_at — first lease renewal. handleSessionControl renews
    // it on every subsequent poll; the sweep job (api/internal/conversation/
    // sweep.ts) treats a session whose heartbeat has gone stale (tab
    // closed/crashed/lost network — session-control simply stops being
    // polled) as abandoned and force-closes it server-side.
    const { data, error } = await sessionsClient()
      .from('ai_provider_sessions')
      .update({ status: 'active', started_at: nowIso, last_heartbeat_at: nowIso, ...(callId ? { provider_session_id: callId } : {}) })
      .eq('id', gatewaySessionId)
      .eq('user_id', userId)
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .in('status', ['authorized', 'connecting'])
      .or(`authorization_expires_at.is.null,authorization_expires_at.gt.${nowIso}`)
      .select('id')
      .maybeSingle();

    if (error || !data) {
      // Foreign session, already active/terminal, or expired — idempotent no-op.
      return res.status(200).json({ status: 'ignored' });
    }

    // Exactly one ai_usage_event represents this physical connection
    // attempt for its entire lifecycle — session-end below locates and
    // updates THIS SAME event (by provider_session_record_id) rather than
    // creating a second one when the session later ends.
    const eventId = await gatewayDeps.usageRepository.startEvent({
      requestId: gatewayDeps.uuidGen(),
      correlationId: gatewaySessionId,
      providerSessionRecordId: gatewaySessionId,
      userId,
      initiatedByUserId: userId,
      actorType: 'user',
      featureKey: WEBRTC_CONNECT_FEATURE_KEY,
      provider: 'openai',
      service: 'realtime.webrtc',
      model: REALTIME_MODEL,
      executionLocation: 'frontend',
      isBillable: false,
      attemptNumber: 1,
      callSequence: 1,
      resourceType: 'ai_provider_session',
      resourceId: gatewaySessionId,
      metadata: { endpoint: 'conversation/session-active' },
      startedAt: startedAtMs,
    });
    await gatewayDeps.usageRepository.completeEvent(eventId, { latencyMs: gatewayDeps.clock() - startedAtMs });
    await gatewayDeps.usageRepository.insertMetrics(eventId, [
      // The browser itself is asserting "I made this physical call and it
      // succeeded" — distinct from provider_event_client_relayed, which
      // relays literal fields copied from an OpenAI-emitted event object
      // (used for conversation.realtime_usage's token metrics below).
      { metricKey: 'provider_requests', unitType: 'request', quantity: 1, isBillable: false, measurementSource: 'client_provider_call_reported' },
    ]);
    try {
      await rebuildDailyBucketForEvent(eventId, { dailyRollupRepository: gatewayDeps.dailyRollupRepository, logger: gatewayDeps.logger });
    } catch (e) {
      gatewayDeps.logger('gateway.webrtcActiveRollup.failed', { message: String(e) });
    }

    return res.status(200).json({ status: 'active' });
  } catch (e) {
    // console.error, not getProductionDeps().logger — the failure that
    // landed here may itself be getProductionDeps() throwing (e.g. missing
    // service-role credentials), and re-calling it here would escape uncaught.
    console.error('[conversation/session-active] gateway telemetry failed', e instanceof Error ? e.message : 'unknown');
    return res.status(200).json({ status: 'ignored' }); // fail-open — never surfaced to the student
  }
}

// ── /failed ──────────────────────────────────────────────────────────────

async function handleSessionFailed(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const body = req.body ?? {};
  const gatewaySessionId = body.gatewaySessionId;
  const reason = typeof body.reason === 'string' && ALLOWED_END_REASONS.has(body.reason) ? body.reason : 'unknown';

  if (!isValidUuid(gatewaySessionId)) {
    return jsonError(res, 400, 'INVALID_GATEWAY_SESSION_ID', 'gatewaySessionId inválido.');
  }

  try {
    const { data, error } = await sessionsClient()
      .from('ai_provider_sessions')
      .update({ status: 'failed', ended_at: new Date().toISOString() })
      .eq('id', gatewaySessionId)
      .eq('user_id', userId)
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .in('status', ['authorized', 'connecting'])
      .select('id')
      .maybeSingle();

    if (error || !data) {
      // Already active/terminal, or foreign — idempotent no-op. An
      // already-active session is never downgraded to failed by a stale report.
      return res.status(200).json({ status: 'ignored' });
    }

    const gatewayDeps = getProductionDeps();
    const startedAt = gatewayDeps.clock();
    const eventId = await gatewayDeps.usageRepository.startEvent({
      requestId: gatewayDeps.uuidGen(),
      correlationId: gatewaySessionId,
      providerSessionRecordId: gatewaySessionId,
      userId,
      initiatedByUserId: userId,
      actorType: 'user',
      featureKey: WEBRTC_CONNECT_FEATURE_KEY,
      provider: 'openai',
      service: 'realtime.webrtc',
      model: REALTIME_MODEL,
      executionLocation: 'frontend',
      isBillable: false,
      attemptNumber: 1,
      callSequence: 1,
      resourceType: 'ai_provider_session',
      resourceId: gatewaySessionId,
      metadata: { endpoint: 'conversation/session-failed' },
      startedAt,
    });
    // No provider_requests metric here: failEvent alone marks the event
    // 'failed' (cost_status auto 'not_applicable') without asserting a
    // metric we cannot prove — a failure reported before the physical POST
    // to /v1/realtime/calls ever went out must never fabricate
    // provider_requests=1.
    await gatewayDeps.usageRepository.failEvent(eventId, {
      latencyMs: gatewayDeps.clock() - startedAt,
      errorCode: reason,
      errorCategory: 'client_reported',
    });

    return res.status(200).json({ status: 'failed' });
  } catch (e) {
    console.error('[conversation/session-failed] gateway telemetry failed', e instanceof Error ? e.message : 'unknown');
    return res.status(200).json({ status: 'ignored' });
  }
}

// ── /usage ───────────────────────────────────────────────────────────────
// Shape mirrors the official OpenAI Realtime response.done `usage` object
// exactly (per-response, incremental — confirmed against
// https://developers.openai.com/api/docs/guides/realtime-costs, verified
// 2026-07-17): total_tokens/input_tokens/output_tokens plus
// input_token_details.{text_tokens,audio_tokens,cached_tokens,
// cached_tokens_details.{text_tokens,audio_tokens}} and
// output_token_details.{text_tokens,audio_tokens}. Only numeric counters are
// read from it — never text, transcript, or any other field.

interface RealtimeUsagePayload {
  input_token_details?: {
    text_tokens?: unknown;
    audio_tokens?: unknown;
    cached_tokens_details?: { text_tokens?: unknown; audio_tokens?: unknown };
  };
  output_token_details?: { text_tokens?: unknown; audio_tokens?: unknown };
}

// Generous per-response ceiling — bounds an implausible/corrupted relayed
// count without rejecting genuine long-context responses.
const MAX_PLAUSIBLE_TOKENS_PER_RESPONSE = 2_000_000;

function toSafeTokenCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), MAX_PLAUSIBLE_TOKENS_PER_RESPONSE);
}

function buildRealtimeUsageMetrics(usage: RealtimeUsagePayload): GatewayUsageMetric[] {
  // measurementSource is 'provider_event_client_relayed', never
  // 'provider_response': the backend never receives this event directly
  // from OpenAI, only via an already-authenticated browser relay.
  const src = 'provider_event_client_relayed';
  return [
    { metricKey: 'provider_requests', unitType: 'request', quantity: 1, isBillable: false, measurementSource: src },
    { metricKey: 'input_text_tokens', unitType: 'token', quantity: toSafeTokenCount(usage.input_token_details?.text_tokens), isBillable: true, measurementSource: src },
    { metricKey: 'cached_input_tokens', unitType: 'token', quantity: toSafeTokenCount(usage.input_token_details?.cached_tokens_details?.text_tokens), isBillable: true, measurementSource: src },
    { metricKey: 'input_audio_tokens', unitType: 'token', quantity: toSafeTokenCount(usage.input_token_details?.audio_tokens), isBillable: true, measurementSource: src },
    { metricKey: 'cached_input_audio_tokens', unitType: 'token', quantity: toSafeTokenCount(usage.input_token_details?.cached_tokens_details?.audio_tokens), isBillable: true, measurementSource: src },
    { metricKey: 'output_text_tokens', unitType: 'token', quantity: toSafeTokenCount(usage.output_token_details?.text_tokens), isBillable: true, measurementSource: src },
    { metricKey: 'output_audio_tokens', unitType: 'token', quantity: toSafeTokenCount(usage.output_token_details?.audio_tokens), isBillable: true, measurementSource: src },
  ];
}

async function handleSessionUsage(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const body = req.body ?? {};
  const { gatewaySessionId, providerResponseId, usage } = body;

  if (!isValidUuid(gatewaySessionId)) {
    return jsonError(res, 400, 'INVALID_GATEWAY_SESSION_ID', 'gatewaySessionId inválido.');
  }
  if (typeof providerResponseId !== 'string' || !PROVIDER_RESPONSE_ID_RE.test(providerResponseId)) {
    return jsonError(res, 400, 'INVALID_PROVIDER_RESPONSE_ID', 'providerResponseId inválido.');
  }
  if (!usage || typeof usage !== 'object') {
    return jsonError(res, 400, 'INVALID_USAGE', 'usage inválido.');
  }

  try {
    // Must be currently 'active' — rejects usage for a session that was
    // never activated, already ended, failed, or expired.
    const { data: session, error } = await sessionsClient()
      .from('ai_provider_sessions')
      .select('id, metadata')
      .eq('id', gatewaySessionId)
      .eq('user_id', userId)
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .eq('status', 'active')
      .maybeSingle();

    if (error || !session) {
      return res.status(200).json({ status: 'ignored' });
    }

    const gatewayDeps = getProductionDeps();

    // Correction: this used to be gated on conversation.realtime_usage's own
    // gatewayMode === 'observe' — but the physical Realtime response (and
    // its real cost) already happened, relayed here from an
    // already-authenticated browser, regardless of what this backend's
    // runtime policy says. Gating telemetry on gatewayMode meant the mode
    // controlled billing, not just enforcement — exactly backwards (mode
    // must never decide whether cost gets recorded, only how the Gateway
    // enforces). This now always records usage and cost, in legacy,
    // observe, and enforce alike — the same fix already applied to
    // conversation.webrtc_connect's bridge above and to
    // pronunciation.assess_text's bridge (api/pronunciation/[...slug].ts).

    // model resolved server-side from the session authorized at
    // conversation.create_session time — never trusted from the client.
    const meta = (session as { metadata?: Record<string, unknown> }).metadata ?? {};
    const model = typeof meta.model === 'string' && meta.model ? meta.model : REALTIME_MODEL;

    const startedAt = gatewayDeps.clock();
    let eventId: string;
    try {
      eventId = await gatewayDeps.usageRepository.startEvent({
        requestId: gatewayDeps.uuidGen(),
        correlationId: gatewaySessionId,
        providerSessionRecordId: gatewaySessionId,
        providerRequestId: providerResponseId,
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        featureKey: REALTIME_USAGE_FEATURE_KEY,
        provider: 'openai',
        service: 'realtime',
        model,
        executionLocation: 'mixed',
        isBillable: true,
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'ai_provider_session',
        resourceId: gatewaySessionId,
        metadata: { endpoint: 'conversation/session-usage' },
        startedAt,
      });
    } catch (e) {
      if (e instanceof DuplicateUsageEventError) {
        // Same response.id relayed twice (retry/StrictMode/race) — already
        // recorded, never double-counted.
        return res.status(200).json({ status: 'duplicate_ignored' });
      }
      throw e;
    }

    // completeEvent()'s UPDATE writes provider_request_id UNCONDITIONALLY
    // from what's passed here (p.providerRequestId ?? null) — it must be
    // re-supplied, or it silently overwrites the value startEvent() just
    // inserted back to NULL. This is exactly what broke deduplication in
    // production: every other feature's completeEvent() call already omits
    // providerRequestId (that column was unused before this feature), so
    // completeEvent's blanket null-write was invisible until this handler
    // populated it at startEvent() time and then wiped it right back out.
    await gatewayDeps.usageRepository.completeEvent(eventId, {
      latencyMs: gatewayDeps.clock() - startedAt,
      providerRequestId: providerResponseId,
    });
    await gatewayDeps.usageRepository.insertMetrics(eventId, buildRealtimeUsageMetrics(usage as RealtimeUsagePayload));

    try {
      await reconcileEventCost(eventId, {
        usageRepository: gatewayDeps.usageRepository,
        pricingRepository: gatewayDeps.pricingRepository,
        logger: gatewayDeps.logger,
      });
    } catch (e) {
      gatewayDeps.logger('gateway.realtimeUsageCost.failed', { message: String(e) });
    }
    try {
      await rebuildDailyBucketForEvent(eventId, { dailyRollupRepository: gatewayDeps.dailyRollupRepository, logger: gatewayDeps.logger });
    } catch (e) {
      gatewayDeps.logger('gateway.realtimeUsageRollup.failed', { message: String(e) });
    }

    return res.status(200).json({ status: 'recorded' });
  } catch (e) {
    console.error('[conversation/session-usage] gateway telemetry failed', e instanceof Error ? e.message : 'unknown');
    return res.status(200).json({ status: 'ignored' }); // fail-open — never surfaced to the student
  }
}

// ── /end ─────────────────────────────────────────────────────────────────

// The client never supplies a duration — session-end computes
// session_seconds itself from server-controlled timestamps only:
// ai_provider_sessions.started_at (written at session-active, from
// gatewayDeps.clock()) through this handler's own gatewayDeps.clock() call.
// This also means session-end attaches session_seconds to the SAME
// ai_usage_event session-active created (located by
// provider_session_record_id + feature_key + status='succeeded') instead of
// creating a second event — one physical connection attempt, one event, for
// its entire lifecycle from connect through disconnect.
async function handleSessionEnd(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const gatewaySessionId = (req.body ?? {}).gatewaySessionId;
  if (!isValidUuid(gatewaySessionId)) {
    return jsonError(res, 400, 'INVALID_GATEWAY_SESSION_ID', 'gatewaySessionId inválido.');
  }

  try {
    const gatewayDeps = getProductionDeps();
    const endedAtMs = gatewayDeps.clock();
    const endedAtIso = new Date(endedAtMs).toISOString();

    const { data, error } = await sessionsClient()
      .from('ai_provider_sessions')
      .update({ status: 'completed', ended_at: endedAtIso })
      .eq('id', gatewaySessionId)
      .eq('user_id', userId)
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .eq('status', 'active')
      .select('id, started_at')
      .maybeSingle();

    if (error || !data) {
      // Never activated, already completed, or foreign — idempotent no-op:
      // a session cannot be completed twice, and only its owner can end it.
      return res.status(200).json({ status: 'ignored' });
    }

    const startedAtIso = (data as { started_at: string | null }).started_at;
    const rawDurationSeconds = startedAtIso ? (endedAtMs - new Date(startedAtIso).getTime()) / 1000 : 0;
    // Finite and non-negative — never trust a clock/parse anomaly into a
    // negative or NaN duration on either the session row or the metric below.
    const durationSeconds = Number.isFinite(rawDurationSeconds) ? Math.max(0, rawDurationSeconds) : 0;

    // Persist the session's own duration immediately — independent of the
    // metric-write below. If that later fails, the session row's own
    // duration_seconds/measurement_source are already durably saved. The
    // status transition above already atomically guaranteed we are the
    // single owner of this completion (a second /session-end call finds no
    // row there and returns before ever reaching this point), so this
    // second UPDATE needs no additional status guard.
    try {
      await sessionsClient()
        .from('ai_provider_sessions')
        .update({ duration_seconds: durationSeconds, measurement_source: 'server_session_timestamps' })
        .eq('id', gatewaySessionId);
    } catch (e) {
      console.error('[conversation/session-end] failed to persist session duration', e instanceof Error ? e.message : 'unknown');
    }

    // Locate the single ai_usage_event session-active created for this
    // physical connection attempt. Never fabricate a new one here: a
    // session can only ever reach 'active' (and thus 'completed') once, so
    // exactly one 'succeeded' conversation.webrtc_connect event can exist
    // for this provider_session_record_id — but if it is somehow missing
    // (never created, already purged, etc.), skip the metric silently
    // rather than inventing a replacement event.
    const { data: eventRow, error: eventLookupError } = await sessionsClient()
      .from('ai_usage_events')
      .select('id')
      .eq('provider_session_record_id', gatewaySessionId)
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('status', 'succeeded')
      .maybeSingle();

    if (!eventLookupError && eventRow) {
      const eventId = (eventRow as { id: string }).id;
      try {
        await gatewayDeps.usageRepository.insertMetrics(eventId, [
          {
            metricKey: 'session_seconds',
            unitType: 'second',
            quantity: durationSeconds,
            isBillable: false, // Realtime cost comes from tokens, not duration.
            measurementSource: 'server_session_timestamps',
          },
        ]);
        await rebuildDailyBucketForEvent(eventId, { dailyRollupRepository: gatewayDeps.dailyRollupRepository, logger: gatewayDeps.logger });
      } catch (e) {
        // Duration-write/rollup failure is fail-open — the session is still
        // correctly marked completed above regardless of this outcome.
        gatewayDeps.logger('gateway.webrtcEndDuration.failed', { message: String(e) });
      }
    }

    return res.status(200).json({ status: 'completed' });
  } catch (e) {
    console.error('[conversation/session-end] gateway telemetry failed', e instanceof Error ? e.message : 'unknown');
    return res.status(200).json({ status: 'ignored' });
  }
}

// ── /control ─────────────────────────────────────────────────────────────
// Etapa 11, Fase 9 — best-effort mid-session termination signal. Polled by
// the client (useRealtimeSession.ts) every ~5s while a session is active and
// the gateway bridge is live (never in legacy mode — see the module comment
// above the bridge handlers). Tells the client to close its own
// RTCPeerConnection when: the server-authorized deadline has passed, the
// feature's kill-switch has been engaged, or the user has been blocked
// since the session started.
//
// Honest limitation (audited against OpenAI's current Realtime API docs,
// 2026-07-18): OpenAI does expose a server-side "hang up" endpoint —
// POST /v1/realtime/calls/{call_id}/hangup — that can forcibly terminate an
// active WebRTC call. But only the browser ever sees that call's call_id:
// this app's architecture has the browser POST its SDP offer directly to
// OpenAI with an ephemeral token (src/hooks/useRealtimeSession.ts), never
// proxied through this backend, so the backend never learns the call_id.
// Trusting a client-reported call_id would not be a real security boundary
// either (a malicious client could simply omit or fake it). Adopting the
// hangup endpoint for a true, unconditional hard-kill would require
// switching to OpenAI's "unified interface" (the browser posts its SDP
// offer to THIS backend, which forwards it to OpenAI with the real secret
// key and gets the call_id back directly) — a larger architectural change,
// out of scope for this stage and left for a future one.
//
// This endpoint is therefore a real, additive safety layer for cooperative
// clients (the official app), not a defense against a deliberately
// malicious one. The unconditional protection this stage does guarantee is
// upstream of this endpoint: kill-switch/blocked-user checks already run at
// /api/conversation/session (new-session issuance), which fully prevents a
// blocked/disabled user from ever starting a NEW session server-side,
// regardless of what any client does. Realtime accordingly stays classified
// blocked_no_hard_session_control in the enforce-readiness preflight and
// must never move to enforce for duration limits until proven otherwise.
// Real server-side termination + outcome persistence — call_id is now
// always captured by handleWebrtcConnect above (best-effort fallback via
// handleSessionActive's client-reported field for an older cached bundle).
// hangupAndPersist (imported at the top of this file) is shared with the
// abandoned-session sweep job (api/internal/conversation/sweep.ts) — see
// api/_realtime-hangup.ts's own doc comment for the full account of the
// endpoint semantics.

// Etapa: per-recording authorized maximum (Fase 12). The frontend must never
// compute this alone — it always comes from here, as the smallest positive
// applicable value among: conversation_max_recording_seconds (when not
// unlimited), the remaining monthly balance (already folds in extra
// purchased credits — see computeFeatureState), and the technical gateway
// ceiling still remaining in this session. When both commercial values are
// unlimited, the result is governed purely by the technical ceiling — which
// the frontend must never present as if it were a commercial benefit.
export type RecordingLimitReason = 'per_turn' | 'monthly_balance' | 'technical';

export interface AuthorizedRecording {
  /**
   * STABLE total budget for this call, measured from startedAtMs — the same
   * quantity the client compares its session-start-relative elapsed time
   * against. Must NOT shrink merely because time passed between polls (only
   * because the underlying entitlement itself changed), or a client comparing
   * elapsed-since-start against a "remaining-from-this-poll" number would
   * stop the recording early — a real bug caught only by live testing.
   */
  authorizedMaxRecordingSeconds: number;
  recordingLimitReason: RecordingLimitReason;
  /** Absolute wall-clock deadline — for server-side terminate decisions only, never sent to the client. */
  effectiveDeadlineMs: number;
}

/**
 * perTurnCapSeconds/monthlyRemainingSeconds are a TOTAL budget for this call
 * (not a fresh grant every poll), so each is anchored to the call's own
 * startedAtMs to get an absolute deadline — never re-based off "now", or a
 * long-running call would silently ignore time it already spent.
 */
function computeAuthorizedRecording(
  entitlements: Awaited<ReturnType<typeof getCurrentUserPlanEntitlements>>,
  startedAtMs: number,
  technicalDeadlineMs: number,
): AuthorizedRecording {
  const perTurnCapSeconds = entitlements.conversation.maxRecordingUnlimited ? Infinity : entitlements.conversation.maxRecordingSeconds;
  const monthlyRemainingSeconds = entitlements.conversation.monthlyTime.unlimited ? Infinity : entitlements.conversation.monthlyTime.remaining;

  const perTurnDeadlineMs = Number.isFinite(perTurnCapSeconds) ? startedAtMs + perTurnCapSeconds * 1000 : Infinity;
  const monthlyDeadlineMs = Number.isFinite(monthlyRemainingSeconds) ? startedAtMs + monthlyRemainingSeconds * 1000 : Infinity;

  const effectiveDeadlineMs = Math.min(technicalDeadlineMs, perTurnDeadlineMs, monthlyDeadlineMs);
  // Session-start-relative, not poll-time-relative — stays stable across polls.
  const authorizedMaxRecordingSeconds = Math.max(0, (effectiveDeadlineMs - startedAtMs) / 1000);

  let recordingLimitReason: RecordingLimitReason;
  if (effectiveDeadlineMs === perTurnDeadlineMs && Number.isFinite(perTurnDeadlineMs)) {
    recordingLimitReason = 'per_turn';
  } else if (effectiveDeadlineMs === monthlyDeadlineMs && Number.isFinite(monthlyDeadlineMs)) {
    recordingLimitReason = 'monthly_balance';
  } else {
    recordingLimitReason = 'technical';
  }

  return { authorizedMaxRecordingSeconds, recordingLimitReason, effectiveDeadlineMs };
}

async function handleSessionControl(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const gatewaySessionId = (req.body ?? {}).gatewaySessionId;
  if (!isValidUuid(gatewaySessionId)) {
    return jsonError(res, 400, 'INVALID_GATEWAY_SESSION_ID', 'gatewaySessionId inválido.');
  }

  try {
    const { data: session, error } = await sessionsClient()
      .from('ai_provider_sessions')
      .select('id, started_at, provider_session_id')
      .eq('id', gatewaySessionId)
      .eq('user_id', userId)
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .eq('status', 'active')
      .maybeSingle();

    if (error || !session) {
      // Not active (never started, already ended via another path, or
      // foreign) — tell the client to stop treating this session as live.
      return res.status(200).json({ terminate: true, reason: 'session_not_active' });
    }

    // Heartbeat/lease renewal — this poll (every ~5s while the client is
    // alive) IS the heartbeat. Renewed unconditionally here, before the
    // terminate checks below, regardless of outcome: a session about to be
    // told to terminate still just had live contact with its client this
    // instant, so it must never look "abandoned" to the sweep job (api/
    // internal/conversation/sweep.ts) purely because this same poll is
    // also the one that ends it. Best-effort — a failure here never blocks
    // the actual terminate/continue decision below.
    try {
      await sessionsClient().from('ai_provider_sessions').update({ last_heartbeat_at: new Date().toISOString() }).eq('id', gatewaySessionId);
    } catch (e) {
      console.error('[conversation/session-control] heartbeat update failed', e instanceof Error ? e.message : 'unknown');
    }

    // Ownership is already enforced by the query above (.eq('user_id',
    // userId)) — a user can never poll control for, and therefore never
    // trigger a hangup on, a session belonging to someone else.
    const providerSessionId = (session as { provider_session_id: string | null }).provider_session_id;
    const terminate = async (reason: string) => {
      // Best-effort, real server-side termination + outcome persistence —
      // see api/_realtime-hangup.ts's doc comment. A hangup failure
      // (including "no call_id captured for this session") never blocks
      // the terminate signal itself: the client still closes its own
      // RTCPeerConnection either way.
      if (providerSessionId) await hangupAndPersist(gatewaySessionId, providerSessionId).catch(() => undefined);
      return res.status(200).json({ terminate: true, reason });
    };

    const startedAtIso = (session as { started_at: string | null }).started_at;
    const startedAtMs = startedAtIso ? new Date(startedAtIso).getTime() : Date.now();
    const deadlineAtMs = startedAtMs + REALTIME_MAX_SESSION_SECONDS * 1000;

    if (Date.now() >= deadlineAtMs) {
      return terminate('max_duration_reached');
    }

    const gatewayDeps = getProductionDeps();

    const policy = await gatewayDeps.policyResolver.resolvePolicy({
      featureKey: WEBRTC_CONNECT_FEATURE_KEY,
      provider: 'openai',
      userId,
      actorType: 'user',
      executionLocation: 'frontend',
    });
    if (evaluateKillSwitch(policy.runtimeStatus).blocked) {
      return terminate('kill_switch');
    }

    if (gatewayDeps.entitlementResolver) {
      try {
        const entitlement = await gatewayDeps.entitlementResolver.resolve(userId, 'user', WEBRTC_CONNECT_FEATURE_KEY, []);
        if (!entitlement.allowed) {
          return terminate('user_blocked');
        }
      } catch (e) {
        // Fail-open — an entitlement check failure must never terminate an
        // otherwise-healthy conversation the student is actively having.
        gatewayDeps.logger('gateway.sessionControl.entitlement.failed', { message: String(e) });
      }
    }

    // Plan-based recording deadline — tightens (never loosens) the technical
    // cap above, using the smaller of conversation_max_recording_seconds and
    // the remaining monthly balance (which already folds in extra purchased
    // credits — see computeFeatureState). Fail-open on error, same
    // philosophy as the entitlement check just above: never cut off an
    // otherwise-healthy call over a transient DB hiccup.
    let authorized: AuthorizedRecording = {
      authorizedMaxRecordingSeconds: Math.max(0, (deadlineAtMs - startedAtMs) / 1000),
      recordingLimitReason: 'technical',
      effectiveDeadlineMs: deadlineAtMs,
    };
    try {
      const entitlements = await getCurrentUserPlanEntitlements(userId);
      authorized = computeAuthorizedRecording(entitlements, startedAtMs, deadlineAtMs);
    } catch (e) {
      gatewayDeps.logger('gateway.sessionControl.planLimit.failed', { message: String(e) });
    }

    if (Date.now() >= authorized.effectiveDeadlineMs) {
      const reason = authorized.recordingLimitReason === 'monthly_balance' ? 'plan_monthly_balance_exhausted' : 'plan_recording_limit_reached';
      return terminate(reason);
    }

    return res.status(200).json({
      terminate: false,
      deadlineAt: new Date(authorized.effectiveDeadlineMs).toISOString(),
      authorizedMaxRecordingSeconds: authorized.authorizedMaxRecordingSeconds,
      recordingLimitReason: authorized.recordingLimitReason,
    });
  } catch (e) {
    console.error('[conversation/session-control] check failed', e instanceof Error ? e.message : 'unknown');
    // Fail-open: a telemetry/DB error here must never cut off an active
    // conversation the student is having.
    return res.status(200).json({ terminate: false });
  }
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  const slug = resolveSlug(req, '/api/conversation');
  switch (slug) {
    case 'preview':        return handlePreview(req, res);
    case 'session':        return handleSession(req, res);
    case 'webrtc-connect': return handleWebrtcConnect(req, res);
    // Flat, single-segment routes — NOT nested (session/active etc.). A
    // nested sub-path under this catch-all 404'd in production: Vercel
    // never routed the extra path segment to this function at all, so
    // requireAuth was never even reached (see the module comment above the
    // bridge handlers for the full account). Single-segment slugs are the
    // same shape as the already-deployed, working 'preview' and 'session'
    // cases above, so this is the proven-safe shape.
    case 'session-active': return handleSessionActive(req, res);
    case 'session-failed': return handleSessionFailed(req, res);
    case 'session-usage':  return handleSessionUsage(req, res);
    case 'session-end':    return handleSessionEnd(req, res);
    case 'session-control': return handleSessionControl(req, res);
    case 'session-complete': return handleSessionComplete(req, res);
    default:                return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
