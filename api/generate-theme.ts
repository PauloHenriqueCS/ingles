import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokensFromMessages, DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';
import { getCurriculumServiceClient } from './_curriculum/service-client';
import { resolveActivityPrompt, CurriculumConfigError } from './_curriculum/curriculum-runtime';
import { resolveWritingThemeLabel } from '../src/domain/writing/writing-themes';
import {
  normalizeGrammarGuide,
  normalizeOptionalExercises,
} from './_mission-grammar-guide';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';
import { checkFeatureConfigError } from './_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../src/domain/entitlements/entitlement-messages';
import type { PlanEntitlementsSnapshot } from '../src/domain/entitlements/entitlement-types';
import { getProductConfig, isWithinConfiguredWindow, resolveConfigEnvironment } from '../src/server/product-config';

const AI_MODEL = 'gpt-4o-mini';

// ── NORMAL-MODE writing generation is now data-driven ──────────────────────────
// The hardcoded English SYSTEM_PROMPT + format/conflict/objective/context
// libraries were removed. The normal-mode prompt is composed from the DB
// curriculum template `writing.generate_topic` for the user's CURRENT recorte
// via resolveActivityPrompt(). There is NO hardcoded English fallback: a
// misconfigured curriculum returns an explicit 503 CURRICULUM_NOT_CONFIGURED.

// ── Review mode (spaced repetition — driven by the student's own errors) ───────
// The review-activity system prompt is now DATA-DRIVEN: it lives in the DB
// template `writing.generate_review_activity` and is composed via
// resolveActivityPrompt(), exactly like normal mode. There is NO hardcoded
// PT/EN prompt or fallback here — a misconfigured curriculum returns an
// explicit 503 CURRICULUM_NOT_CONFIGURED.

interface ReviewItemPayload {
  originalValue: string;
  correctedValue: string;
  explanation: string | null;
  originalSentence: string | null;
}

interface ReviewGroupPayload {
  group: {
    id: string;
    originalTheme: string | null;
    sourceEntryDate: string | null;
    reviewLevel: number;
  };
  items: ReviewItemPayload[];
}

function buildReviewUserMessage(
  reviewGroup: ReviewGroupPayload,
  recentThemes: RecentThemeRow[],
  level: string,
  attempt: number,
  selectedTheme: string | null = null,
): string {
  const lines: string[] = [];

  lines.push('=== PERFIL DO ALUNO ===');
  lines.push(`Nível: ${level}`);

  // User-requested theme — same contract as normal mode: when present, it
  // overrides the review group's own originalTheme for the new scenario.
  // It never touches requiredWords, which stays bound exclusively to the
  // student's corrected errors regardless of theme.
  if (selectedTheme) {
    lines.push('');
    lines.push('=== TEMA OBRIGATÓRIO ===');
    lines.push(`TEMA OBRIGATÓRIO ESCOLHIDO PELO USUÁRIO: ${selectedTheme}.`);
    lines.push('A nova situação criada para esta revisão deve ser centralizada nesse assunto, mesmo que o tema original do grupo de revisão abaixo seja outro.');
    lines.push('Isso NUNCA afeta requiredWords: as palavras obrigatórias continuam sendo exatamente as corrigidas do aluno, apenas encaixadas numa situação sobre este tema.');
    lines.push('Este tema tem prioridade máxima sobre o "Tema original" do grupo de revisão listado abaixo.');
  }

  lines.push('');
  lines.push('=== GRUPO DE REVISÃO ===');
  lines.push(`ID do grupo: ${reviewGroup.group.id}`);
  if (reviewGroup.group.originalTheme) {
    lines.push(`Tema original: ${reviewGroup.group.originalTheme}`);
  }

  lines.push('');
  lines.push('Erros cometidos pelo aluno:');
  reviewGroup.items.forEach((item, i) => {
    lines.push(`[${i + 1}]`);
    lines.push(`  Errado:  "${item.originalValue}"`);
    lines.push(`  Correto: "${item.correctedValue}"`);
    if (item.explanation) lines.push(`  Explicação: ${item.explanation}`);
    if (item.originalSentence) lines.push(`  Frase original: "${item.originalSentence}"`);
  });

  const uniqueWords = [...new Set(reviewGroup.items.map((i) => i.correctedValue).filter(Boolean))];
  lines.push('');
  lines.push('=== PALAVRAS OBRIGATÓRIAS (copiar exatamente para requiredWords) ===');
  uniqueWords.forEach((w) => lines.push(`  - "${w}"`));

  if (recentThemes.length > 0) {
    lines.push('');
    lines.push('=== HISTÓRICO RECENTE (NÃO REPETIR FORMATO) ===');
    recentThemes.slice(0, 5).forEach((t, i) => {
      const fmt = extractField(t.semantic_summary, 'Formato') || t.activity_type || '—';
      lines.push(`[${i + 1}] Formato: ${fmt} | Contexto: ${t.context || '—'} | "${t.title}"`);
    });
  }

  if (attempt > 1) {
    lines.push('');
    lines.push(`⚠️ TENTATIVA ${attempt}: A resposta anterior foi inválida. Certifique-se de que:`);
    lines.push('  - requiredWords contém EXATAMENTE as palavras listadas acima (sem adicionar nem remover)');
    lines.push('  - reviewGroupId é copiado exatamente');
    lines.push('  - activityType é diferente do último formato utilizado');
  }

  lines.push('');
  lines.push(`IMPORTANTE: O campo reviewGroupId deve ser exatamente: "${reviewGroup.group.id}"`);
  if (selectedTheme) {
    lines.push(`Siga os 6 passos. O TEMA OBRIGATÓRIO acima não é negociável — a situação criada deve girar em torno dele, não do tema original do grupo.`);
  } else {
    lines.push('Siga os 6 passos e gere uma atividade de revisão natural e envolvente.');
  }

  return lines.join('\n');
}

export function normalizeReviewTheme(
  parsed: any,
  reviewGroupId: string,
  expectedWords: string[]
): Record<string, unknown> {
  const missionSetup = String(parsed.missionSetup || '');
  const missionTask = String(parsed.missionTask || '');
  const mission =
    String(parsed.mission || '') ||
    (missionSetup && missionTask ? `${missionSetup} ${missionTask}`.trim() : '');

  const rawRequired = Array.isArray(parsed.requiredWords)
    ? parsed.requiredWords.map((w: any) => String(w).trim()).filter(Boolean)
    : expectedWords;
  const requiredWords = [...new Set<string>(rawRequired)];

  const format = String(parsed.activityType || parsed.format || 'narrative');
  const objective = String(parsed.objective || '');
  const summaryParts: string[] = [];
  if (format) summaryParts.push(`Formato: ${format}`);
  if (objective) summaryParts.push(`Objetivo: ${objective}`);
  const semanticSummary =
    String(parsed.semanticSummary || '') || summaryParts.join(' | ');

  return {
    title: String(parsed.title || 'Revisão'),
    missionSetup,
    missionTask,
    mission,
    themePtBr: mission,
    themeEn: String(parsed.themeEn || ''),
    objective,
    pedagogicalReason: String(parsed.pedagogicalReason || ''),
    activityType: format,
    format,
    context: String(parsed.context || ''),
    conflict: '',
    semanticSummary,
    level: VALID_LEVELS.has(parsed.level) ? parsed.level : 'A1',
    difficulty: VALID_DIFFS.has(parsed.difficulty) ? parsed.difficulty : 'easy',
    estimatedTimeMinutes: Number(parsed.estimatedTimeMinutes) || 15,
    requiredGrammar: Array.isArray(parsed.requiredGrammar) ? parsed.requiredGrammar : [],
    requiredWords,
    suggestedVocabulary: Array.isArray(parsed.suggestedVocabulary)
      ? parsed.suggestedVocabulary
      : [],
    useTheseWords: [],
    instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
    exampleSentence: String(parsed.exampleSentence || ''),
    successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
    extraChallenge: '',
    category: String(parsed.category || 'review'),
    grammarTips: {},
    responseExamples: [],
    mode: 'review',
    reviewGroupId,
    verbTense: String(parsed.verbTense || ''),
    grammarGuide: normalizeGrammarGuide(parsed.grammarGuide),
    optionalExercises: normalizeOptionalExercises(parsed.optionalExercises),
  };
}

export function validateReviewTheme(
  theme: Record<string, unknown>,
  expectedWords: string[],
  reviewGroupId: string
): string | null {
  const rw = Array.isArray(theme.requiredWords) ? (theme.requiredWords as string[]) : [];

  const missing = expectedWords.filter((w) => !rw.includes(w));
  if (missing.length > 0) return `Palavras faltando em requiredWords: ${missing.join(', ')}`;

  const extra = rw.filter((w) => !expectedWords.includes(w));
  if (extra.length > 0) return `Palavras extras em requiredWords: ${extra.join(', ')}`;

  if (rw.some((w) => !w?.trim())) return 'requiredWord vazia encontrada';

  if (new Set(rw).size !== rw.length) return 'requiredWords contém duplicatas';

  if (!String(theme.title || '').trim()) return 'title vazio';
  if (!String(theme.mission || '').trim()) return 'mission vazia';

  if (theme.mode !== 'review') return 'mode !== review';
  if (theme.reviewGroupId !== reviewGroupId) return `reviewGroupId inválido: ${theme.reviewGroupId}`;

  const reqLower = rw.map((w) => w.toLowerCase());
  const suggested = Array.isArray(theme.suggestedVocabulary)
    ? (theme.suggestedVocabulary as any[]).map((v) =>
        String(typeof v === 'string' ? v : v?.word || '').toLowerCase()
      )
    : [];
  const overlap = suggested.filter((w) => w && reqLower.includes(w));
  if (overlap.length > 0) return `suggestedVocabulary repete requiredWords: ${overlap.join(', ')}`;

  return null;
}

// ── Build user message ────────────────────────────────────────────────────────

interface RecentThemeRow {
  title: string;
  activity_type: string | null;
  context: string | null;
  semantic_summary: string | null;
}

interface ExcludedTheme {
  title: string;
  format?: string;
  activityType?: string;
  conflict?: string;
  context?: string;
  semanticSummary?: string;
}

function extractField(summary: string | null, field: string): string {
  if (!summary) return '';
  const match = summary.match(new RegExp(`${field}:\\s*([^|\\n]+)`));
  return match ? match[1].trim() : '';
}

// ── Semantic deduplication ────────────────────────────────────────────────────

export function jaccardSimilarity(a: string, b: string): number {
  const stopwords = new Set([
    'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com',
    'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'sua',
    'seu', 'sobre', 'the', 'an', 'to', 'of', 'in', 'on', 'at', 'and',
    'or', 'is', 'was', 'are', 'were', 'you', 'your',
  ]);
  const tokenize = (s: string): Set<string> => {
    const words = s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopwords.has(w));
    return new Set(words);
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export function isTooSimilar(
  candidate: Record<string, unknown>,
  recentThemes: RecentThemeRow[],
  threshold = 0.32
): boolean {
  const candidateText = [
    candidate.title,
    candidate.semanticSummary,
    candidate.format,
    candidate.context,
    candidate.conflict,
    candidate.objective,
    candidate.missionSetup,
  ]
    .filter(Boolean)
    .join(' ');

  // Semantic similarity check
  for (const t of recentThemes.slice(0, 10)) {
    const existingText = [t.title, t.semantic_summary, t.activity_type, t.context]
      .filter(Boolean)
      .join(' ');
    if (jaccardSimilarity(candidateText, existingText) > threshold) {
      return true;
    }
  }

  // Hard rule: never same format as immediately previous theme
  const lastFormat = extractField(recentThemes[0]?.semantic_summary, 'Formato')
    || recentThemes[0]?.activity_type;
  if (candidate.format && lastFormat && candidate.format === lastFormat) {
    return true;
  }

  return false;
}

// ── Normalize AI output ───────────────────────────────────────────────────────

const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const VALID_DIFFS = new Set(['easy', 'medium', 'hard']);

export function normalizeTheme(parsed: any): Record<string, unknown> {
  const format = String(parsed.format || parsed.activityType || 'história');
  const conflict = String(parsed.conflict || '');
  const objective = String(parsed.objective || '');
  const missionSetup = String(parsed.missionSetup || '');
  const missionTask = String(parsed.missionTask || '');
  const mission =
    missionSetup && missionTask
      ? `${missionSetup} ${missionTask}`.trim()
      : String(parsed.mission || missionSetup || missionTask || '');

  // Build structured semantic_summary so history extraction works reliably
  const summaryParts: string[] = [];
  if (format) summaryParts.push(`Formato: ${format}`);
  if (conflict) summaryParts.push(`Conflito: ${conflict}`);
  if (objective) summaryParts.push(`Objetivo: ${objective}`);
  const aiSummary = String(parsed.semanticSummary || '');
  // Append the AI's natural description after the structured prefix
  const naturalPart = aiSummary.includes('Formato:') ? '' : aiSummary;
  if (naturalPart) summaryParts.push(naturalPart);
  const semanticSummary = summaryParts.join(' | ');

  return {
    title: String(parsed.title || 'Missão do dia'),
    missionSetup,
    missionTask,
    mission,
    themePtBr: mission,
    themeEn: String(parsed.themeEn || ''),
    format,
    context: String(parsed.context || 'geral'),
    conflict,
    objective,
    activityType: format,
    semanticSummary,
    whyThisActivity: String(parsed.whyThisActivity || ''),
    level: VALID_LEVELS.has(parsed.level) ? parsed.level : 'A1',
    difficulty: VALID_DIFFS.has(parsed.difficulty) ? parsed.difficulty : 'easy',
    estimatedTimeMinutes: Number(parsed.estimatedTimeMinutes) || 15,
    requiredGrammar: Array.isArray(parsed.requiredGrammar) ? parsed.requiredGrammar : [],
    suggestedVocabulary: Array.isArray(parsed.suggestedVocabulary) ? parsed.suggestedVocabulary : [],
    useTheseWords: Array.isArray(parsed.useTheseWords) ? parsed.useTheseWords : [],
    instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
    exampleSentence: String(parsed.exampleSentence || ''),
    successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
    extraChallenge: String(parsed.extraChallenge || ''),
    category: String(parsed.category || 'daily-life'),
    grammarTips:
      parsed.grammarTips && typeof parsed.grammarTips === 'object' && !Array.isArray(parsed.grammarTips)
        ? parsed.grammarTips
        : {},
    responseExamples: Array.isArray(parsed.responseExamples) ? parsed.responseExamples : [],
    verbTense: String(parsed.verbTense || ''),
    grammarGuide: normalizeGrammarGuide(parsed.grammarGuide),
    optionalExercises: normalizeOptionalExercises(parsed.optionalExercises),
  };
}

/**
 * When the user explicitly picked a theme, force the mission's displayed
 * context/tag to that theme's label. The AI's own `context` choice (or,
 * in review mode, a leftover from the review group's unrelated
 * originalTheme) must never override an explicit user selection — the tag
 * shown in the UI has to reflect what the user picked, not an internal
 * mission-structure code like "planning".
 */
export function applySelectedTopicOverride(
  candidate: Record<string, unknown>,
  selectedTheme: string | null,
): void {
  if (selectedTheme) {
    candidate.context = selectedTheme;
  }
}

export function parseRawContent(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractThemeMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.THEME)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de geração não está configurado.');

  if (!await applyRateLimit(res, userId, 'generate-theme')) return;

  // ── Plan entitlements ────────────────────────────────────────────────────────
  // writing.enabled gates the ENTIRE endpoint, including reusing an already-
  // generated mission — when the plan turns writing off, nothing comes back.
  // The per-day generation limit (themeGenerations) is checked separately,
  // right before each place a NEW AI call is about to happen, so it never
  // blocks reusing the diagnostic flow's already-generated mission.
  let entitlements: PlanEntitlementsSnapshot;
  try {
    entitlements = await getCurrentUserPlanEntitlements(userId);
  } catch (e) {
    safeLog('generate-theme', 'entitlements_resolve_failed', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível verificar seu plano. Tente novamente.');
  }
  const writingConfigErrorCheck = checkFeatureConfigError(entitlements.writing.themeGenerations);
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
  function blockedByGenerationLimit(): { code: string; message: string } | null {
    if (entitlements.writing.themeGenerations.canStart) return null;
    const code = entitlements.writing.themeGenerations.state === 'monthly_limit_reached'
      ? 'MONTHLY_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED';
    return { code, message: ENTITLEMENT_MESSAGES.writingGenerationsExhausted };
  }

  const { mode, reviewGroup, learningContext, previousThemeId, excludedTheme, theme: rawTheme } = req.body ?? {};
  // The client sends the raw technical value from the theme select (e.g.
  // 'football_sports'); it is resolved to a display label from the single
  // canonical writing-themes list (a UI option list of SURFACE topics — never
  // authoritative pedagogy) and handed to the curriculum engine as OPTIONAL
  // context (userContext.selected_theme). The DB curriculum template decides how
  // (or whether) to use it; the user's CURRENT recorte remains the sole
  // authority over what is taught. An unrecognized/empty value => no theme.
  const normalizedThemeValue = typeof rawTheme === 'string' && rawTheme.trim() ? rawTheme.trim() : null;
  const selectedTheme = resolveWritingThemeLabel(normalizedThemeValue);

  // Mark previous theme as regenerated (only if it belongs to this user)
  if (previousThemeId) {
    try {
      await supabase
        .from('generated_themes')
        .update({ status: 'regenerated' })
        .eq('id', previousThemeId)
        .eq('user_id', userId);
    } catch (e) {
      console.error('Failed to update previous theme status:', e);
    }
  }

  // Fetch recent theme history for THIS user only
  let recentThemes: RecentThemeRow[] = [];
  try {
    const { data } = await supabase
      .from('generated_themes')
      .select('title, activity_type, context, semantic_summary')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30);
    recentThemes = (data ?? []) as RecentThemeRow[];
  } catch (e) {
    console.error('Failed to fetch recent themes:', e);
  }

  const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.LONG, maxRetries: 0 });

  // ── Gateway context — one correlationId per HTTP request, one physical- ────
  // attempt counter shared across every phase (diagnostic/review/normal),
  // never reset when the request moves from one phase to another.
  const gatewayDeps = getProductionDeps();
  const correlationId = gatewayDeps.uuidGen();
  let physicalAttempt = 0;

  async function callTheme(
    phase: 'review' | 'normal',
    phaseAttempt: number,
    maxPhysicalAttempts: number,
    params: ChatCompletionCreateParamsNonStreaming,
  ): Promise<ChatCompletion> {
    physicalAttempt += 1;
    return executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'writing.generate_topic',
        provider: 'openai',
        service: 'chat.completions',
        model: typeof params.model === 'string' ? params.model : AI_MODEL,
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId,
        attemptNumber: physicalAttempt,
        callSequence: 1,
        resourceType: 'generated_theme',
        technicalMetadata: {
          endpoint: 'generate-theme',
          phase,
          phaseAttempt,
          physicalAttempt,
          maxPhysicalAttempts,
          flowType: mode === 'review' ? 'review' : 'normal',
        },
        estimatedMetrics: estimateTextTokensFromMessages(
          params.messages, typeof params.max_tokens === 'number' ? params.max_tokens : DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
        ),
      },
      () => openai.chat.completions.create(params),
      gatewayDeps,
      extractThemeMetrics,
    );
  }

  // ── REVIEW MODE ──────────────────────────────────────────────────────────────
  if (mode === 'review' && reviewGroup) {
    const rg = reviewGroup as ReviewGroupPayload;
    const group = rg.group;
    const items = rg.items ?? [];

    if (!group?.id || items.length === 0) {
      return res.status(400).json({ error: 'Grupo de revisão inválido.', mode: 'review' });
    }

    const expectedWords = [...new Set<string>(items.map((i) => i.correctedValue).filter(Boolean))];
    const level = String((learningContext as any)?.currentLevel || 'A1');

    const reviewGenerationBlock = blockedByGenerationLimit();
    if (reviewGenerationBlock) {
      return jsonError(res, 403, reviewGenerationBlock.code, reviewGenerationBlock.message);
    }

    // ── DATA-DRIVEN REVIEW PROMPT ───────────────────────────────────────────
    // The spaced-repetition review activity prompt is composed from the DB
    // template `writing.generate_review_activity` for the user's learning +
    // interface language. The dynamically-built review context (student errors,
    // required words, recent-format history, and any user-selected theme) is
    // handed over as OPTIONAL userContext (review_context); the template owns
    // ALL pedagogy. requireSubtopic=false — review is not part of the curricular
    // progression. There is NO hardcoded PT/EN fallback: a misconfigured
    // curriculum is an explicit 503 CURRICULUM_NOT_CONFIGURED.
    const reviewContext = buildReviewUserMessage(
      { group, items },
      recentThemes,
      level,
      1,
      selectedTheme,
    );
    let resolvedReviewPrompt;
    try {
      resolvedReviewPrompt = await resolveActivityPrompt(getCurriculumServiceClient(), userId, {
        templateKey: 'writing.generate_review_activity',
        activityType: 'writing',
        requireSubtopic: false,
        userContext: { review_context: reviewContext },
      });
    } catch (err) {
      if (err instanceof CurriculumConfigError) {
        safeLog('generate-theme', 'curriculum_not_configured', 503, {
          detail: String(err.message).slice(0, 150),
        });
        return jsonError(
          res,
          503,
          'CURRICULUM_NOT_CONFIGURED',
          'O currículo de escrita ainda não está configurado. Tente novamente mais tarde.',
        );
      }
      throw err;
    }

    const reviewModel = resolvedReviewPrompt.model ?? AI_MODEL;
    const reviewSystem = resolvedReviewPrompt.system;
    const reviewUser = resolvedReviewPrompt.user ?? 'Gere a atividade de revisão agora.';

    const MAX_REVIEW_ATTEMPTS = 3;
    let reviewTheme: Record<string, unknown> | null = null;
    let lastValidationError: string | null = null;

    for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        const completion = await callTheme('review', attempt, MAX_REVIEW_ATTEMPTS, {
          model: reviewModel,
          temperature: resolvedReviewPrompt.temperature ?? (0.85 + (attempt - 1) * 0.08),
          messages: [
            { role: 'system', content: reviewSystem },
            { role: 'user', content: reviewUser },
          ],
        });
        raw = completion.choices[0]?.message?.content ?? '';
      } catch (err) {
        const { code, status } = sanitizeProviderError(err);
        if (code === 'AI_TIMEOUT') {
          safeLog('generate-theme', 'timeout', status, { mode: 'review' });
          return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
        }
        if (code === 'AI_UNAVAILABLE') {
          safeLog('generate-theme', 'provider_unavailable', status, { mode: 'review' });
          return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
        }
        if (attempt >= MAX_REVIEW_ATTEMPTS) {
          return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar a atividade de revisão. Tente novamente.');
        }
        continue;
      }

      const parsed = parseRawContent(raw);
      if (!parsed) {
        console.error(`Review attempt ${attempt}: JSON inválido`);
        continue;
      }

      const candidate = normalizeReviewTheme(parsed, group.id, expectedWords);
      lastValidationError = validateReviewTheme(candidate, expectedWords, group.id);

      if (lastValidationError) {
        console.warn(`Review attempt ${attempt} falhou validação: ${lastValidationError}`);
        continue;
      }

      reviewTheme = candidate;
      break;
    }

    if (!reviewTheme) {
      safeLog('generate-theme', 'review_validation_failed', 500);
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar uma atividade de revisão válida. Tente novamente.');
    }

    applySelectedTopicOverride(reviewTheme, selectedTheme);

    let themeId: string | null = null;
    try {
      const { data, error } = await supabase
        .from('generated_themes')
        .insert({
          user_id: userId,
          title: reviewTheme.title,
          description: reviewTheme.mission,
          grammar_focus: reviewTheme.requiredGrammar,
          activity_type: reviewTheme.activityType,
          context: reviewTheme.context,
          semantic_summary: reviewTheme.semanticSummary,
          difficulty: reviewTheme.difficulty,
          vocabulary: reviewTheme.requiredWords,
          status: 'generated',
        })
        .select('id')
        .single();
      if (!error && data) themeId = (data as { id: string }).id;
    } catch (e) {
      console.error('Failed to save review theme:', e);
    }

    return res.json({ theme: reviewTheme, themeId, mode: 'review' });
  }

  // ── NORMAL MODE ──────────────────────────────────────────────────────────────

  const normalGenerationBlock = blockedByGenerationLimit();
  if (normalGenerationBlock) {
    return jsonError(res, 403, normalGenerationBlock.code, normalGenerationBlock.message);
  }

  // Inject excluded theme at the top so deduplication catches it immediately
  if (excludedTheme) {
    const alreadyPresent = recentThemes.some((t) => t.title === excludedTheme.title);
    if (!alreadyPresent) {
      recentThemes = [
        {
          title: excludedTheme.title ?? '',
          activity_type: excludedTheme.format ?? excludedTheme.activityType ?? null,
          context: excludedTheme.context ?? null,
          semantic_summary: excludedTheme.semanticSummary ?? null,
        },
        ...recentThemes,
      ];
    }
  }

  // ── DATA-DRIVEN CURRICULUM PROMPT ───────────────────────────────────────────
  // The normal-mode writing mission is composed from the DB template
  // `writing.generate_topic` for the user's CURRENT recorte. The generic
  // curriculum engine owns ALL pedagogy — this endpoint only runs the AI
  // Gateway call, parses, dedups and persists. There is NO hardcoded English
  // fallback: a misconfigured curriculum is an explicit operational error.
  let resolvedPrompt;
  try {
    resolvedPrompt = await resolveActivityPrompt(getCurriculumServiceClient(), userId, {
      templateKey: 'writing.generate_topic',
      activityType: 'writing',
      // Dynamic bits the template MAY consume (unreferenced keys are harmless).
      userContext: selectedTheme ? { selected_theme: selectedTheme } : undefined,
    });
  } catch (err) {
    if (err instanceof CurriculumConfigError) {
      safeLog('generate-theme', 'curriculum_not_configured', 503, {
        detail: String(err.message).slice(0, 150),
      });
      return jsonError(
        res,
        503,
        'CURRICULUM_NOT_CONFIGURED',
        'O currículo de escrita ainda não está configurado. Tente novamente mais tarde.',
      );
    }
    throw err;
  }

  const normalModel = resolvedPrompt.model ?? AI_MODEL;
  const normalSystem = resolvedPrompt.system;
  const normalUser = resolvedPrompt.user ?? 'Gere a missão de escrita agora.';
  const baseTemperature = resolvedPrompt.temperature ?? 0.88;

  const MAX_ATTEMPTS = 3;
  let theme: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;

    try {
      const completion = await callTheme('normal', attempt, MAX_ATTEMPTS, {
        model: normalModel,
        // Bump temperature per attempt to diversify retries against the
        // history-based similarity guard below.
        temperature: baseTemperature + (attempt - 1) * 0.06,
        messages: [
          { role: 'system', content: normalSystem },
          { role: 'user', content: normalUser },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '';
    } catch (err) {
      const { code, status } = sanitizeProviderError(err);
      if (code === 'AI_TIMEOUT') {
        safeLog('generate-theme', 'timeout', status);
        return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
      }
      if (code === 'AI_UNAVAILABLE') {
        safeLog('generate-theme', 'provider_unavailable', status);
        return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
      }
      if (attempt >= MAX_ATTEMPTS) {
        return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar a missão. Tente novamente.');
      }
      continue;
    }

    const parsed = parseRawContent(raw);
    if (!parsed) {
      console.error(`Attempt ${attempt}: invalid JSON`);
      continue;
    }

    const candidate = normalizeTheme(parsed);

    // Skip similarity check on last attempt to guarantee a response
    if (attempt < MAX_ATTEMPTS && isTooSimilar(candidate, recentThemes)) {
      console.log(`Attempt ${attempt}: too similar to history, retrying…`);
      continue;
    }

    theme = candidate;
    break;
  }

  if (!theme) {
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar uma missão diferente. Tente novamente.');
  }

  applySelectedTopicOverride(theme, selectedTheme);

  // Persist to database
  let themeId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('generated_themes')
      .insert({
        user_id: userId,
        title: theme.title,
        description: theme.mission,
        grammar_focus: theme.requiredGrammar,
        activity_type: theme.format,
        context: theme.context,
        semantic_summary: theme.semanticSummary,
        difficulty: theme.difficulty,
        vocabulary: theme.useTheseWords,
        status: 'generated',
      })
      .select('id')
      .single();
    if (!error && data) {
      themeId = (data as { id: string }).id;
    }
  } catch (e) {
    console.error('Failed to save generated theme:', e);
  }

  return res.json({ theme, themeId, mode: 'normal' });
}
