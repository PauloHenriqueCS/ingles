import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog, sanitizeProviderError, resolveSlug } from '../_helpers';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens } from '../_ai-gateway/index';
import type { GatewayUsageMetric } from '../_ai-gateway/index';
import { applyRateLimit } from '../_rateLimit';
import { getCurrentUserPlanEntitlements } from '../_entitlements/plan-entitlements-service';
import { checkFeatureConfigError } from '../_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../../src/domain/entitlements/entitlement-messages';
import { evaluateSkillPromotion } from '../../src/lib/promotionService';
import type { PromotionTrigger } from '../../src/domain/promotion/promotion-types';

// "Treinar pronúncia" (PronunciationTrainingView) is a standalone practice
// flow, distinct from the plan-metered pronunciation.evaluations quota used
// by api/pronunciation/[...slug].ts's official assessment (start/complete).
// It was previously reachable with NO entitlement check at all — a plan with
// pronunciation.enabled=false could still call generate-text (OpenAI cost)
// and token (Azure Speech STS) directly, bypassing the "disabled_by_plan"
// lock HomePage shows for the same card. This gate re-applies only the
// on/off flag: per-attempt counting (analyses/day) is intentionally left
// alone here since the product only defines that limit for the *official*
// evaluation path — see final audit report for the open decision on whether
// standalone practice should also carry its own counted limit.
async function requirePronunciationEnabled(userId: string): Promise<{ status: number; code: string; message: string } | null> {
  let entitlements;
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
  return null;
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

async function handleGenerateText(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  const accessDenial = await requirePronunciationEnabled(auth.userId);
  if (accessDenial) return jsonError(res, accessDenial.status, accessDenial.code, accessDenial.message);
  if (!await applyRateLimit(res, auth.userId, 'pronunciation-training-generate-text')) return;

  let userLevel = 'A2';
  try {
    const { data } = await supabase.from('english_learning_memory').select('current_level').eq('user_id', auth.userId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
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
        userId: auth.userId,
        initiatedByUserId: auth.userId,
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
    safeLog('pronunciation-training/generate-text', 'success', 200);
    return res.status(200).json({ text, level: userLevel });
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

  const accessDenial = await requirePronunciationEnabled(auth.userId);
  if (accessDenial) return jsonError(res, accessDenial.status, accessDenial.code, accessDenial.message);
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
    safeLog('plan-entitlements', 'resolve_failed', 500);
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
    case 'plan-entitlements': return handlePlanEntitlements(req, res);
    case 'evaluate':          return handlePromotionEvaluate(req, res);
    default:                  return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
