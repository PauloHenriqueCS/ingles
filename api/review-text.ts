import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens, DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';
import { checkTextLength } from './_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../src/domain/entitlements/entitlement-messages';

const AI_MODEL = 'gpt-4o-mini';

// ── Types ─────────────────────────────────────────────────────────────────────

type RequiredWordEvaluationStatus =
  | 'correct'
  | 'incorrect_spelling'
  | 'incorrect_usage'
  | 'missing'
  | 'forced_usage';

interface RequiredWordEvaluation {
  requiredWord: string;
  status: RequiredWordEvaluationStatus;
  usedExcerpt: string | null;
  explanation: string;
  suggestedCorrection: string | null;
}

interface GroupItem {
  id: string;
  original_value: string;
  corrected_value: string;
  explanation: string | null;
  original_sentence: string | null;
}

// ── Normal mode system prompt ─────────────────────────────────────────────────

const NORMAL_SYSTEM_PROMPT = `Você é um professor de inglês para brasileiros adultos iniciantes.

Avalie o texto em inglês escrito pelo usuário.

Responda sempre em português do Brasil, exceto nos campos de texto corrigido, exemplos e palavras em inglês.

Você deve ser didático, direto e encorajador. Não seja agressivo. O objetivo é ensinar, não humilhar.

Analise:
- gramática
- vocabulário
- naturalidade
- fluência
- cumprimento do objetivo do dia

Retorne somente JSON válido. Não use markdown. Não escreva nada antes ou depois do JSON.

Formato obrigatório:

{
  "score": number,
  "level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2",
  "grammar": number,
  "vocabulary": number,
  "naturalness": number,
  "fluency": number,
  "summary": string,
  "correctedText": string,
  "mainMistakes": [
    {
      "original": string,
      "correct": string,
      "explanation": string
    }
  ],
  "newVocabulary": [
    {
      "word": string,
      "meaningPtBr": string,
      "example": string
    }
  ],
  "objectiveFeedback": string,
  "nextPractice": string
}

Regras:
- score deve ir de 0 a 100.
- grammar, vocabulary, naturalness e fluency devem ir de 0 a 100.
- level deve ser A1, A2, B1, B2, C1 ou C2.
- correctedText deve corrigir o texto mantendo a ideia original do aluno, em inglês.
- mainMistakes deve conter no máximo 5 erros principais.
- newVocabulary deve conter de 3 a 5 itens.
- objectiveFeedback deve explicar se o objetivo gramatical do dia foi cumprido.
- nextPractice deve ser uma tarefa curta e prática para o próximo treino.
- Se o texto for muito curto, avalie mesmo assim e explique no summary que a nota ficou baixa por falta de conteúdo.
- Se o texto estiver vazio ou quase vazio, retorne score 0 e peça para o usuário escrever pelo menos 3 frases.`;

// ── Review mode system prompt ─────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `Você é um professor de inglês para brasileiros adultos iniciantes.

Este texto foi submetido como parte de uma ATIVIDADE DE REVISÃO ESPAÇADA.
O aluno está praticando palavras e estruturas que apresentaram erros em atividades anteriores.

Avalie o texto completamente. Além da correção padrão, avalie cada palavra obrigatória individualmente.

Para cada palavra obrigatória, siga estes passos:
1. Localize a palavra ou expressão no texto do aluno.
2. Verifique a ortografia.
3. Verifique o significado e uso contextual.
4. Verifique a gramática e naturalidade.
5. Classifique com exatamente um dos status abaixo.

Status permitidos:
- correct: escrita corretamente e usada adequadamente no contexto.
- incorrect_spelling: o aluno tentou usar a palavra mas a escreveu incorretamente.
- incorrect_usage: escrita correta mas usada com sentido, preposição, tempo verbal ou estrutura inadequada.
- missing: não aparece no texto.
- forced_usage: aparece mas foi inserida artificialmente, desconectada ou sem sentido apenas para cumprir a obrigação.

Responda sempre em português do Brasil, exceto nos campos correctedText, usedExcerpt e suggestedCorrection (sempre em inglês).

Retorne somente JSON válido. Não use markdown. Não escreva nada antes ou depois do JSON.

Formato obrigatório:

{
  "score": number,
  "level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2",
  "grammar": number,
  "vocabulary": number,
  "naturalness": number,
  "fluency": number,
  "summary": string,
  "correctedText": string,
  "mainMistakes": [{"original": string, "correct": string, "explanation": string}],
  "newVocabulary": [{"word": string, "meaningPtBr": string, "example": string}],
  "objectiveFeedback": string,
  "nextPractice": string,
  "requiredWordEvaluation": [
    {
      "requiredWord": string,
      "status": "correct" | "incorrect_spelling" | "incorrect_usage" | "missing" | "forced_usage",
      "usedExcerpt": string | null,
      "explanation": string,
      "suggestedCorrection": string | null
    }
  ]
}

Regras para os campos principais:
- score, grammar, vocabulary, naturalness, fluency: 0 a 100.
- level: A1, A2, B1, B2, C1 ou C2.
- correctedText: corrigir mantendo a ideia original, em inglês.
- mainMistakes: no máximo 5 erros.
- newVocabulary: 3 a 5 itens.
- objectiveFeedback: se o objetivo gramatical foi cumprido.
- nextPractice: tarefa curta para o próximo treino.

Regras para requiredWordEvaluation:
- Retornar exatamente um item para cada palavra obrigatória recebida, na mesma ordem.
- requiredWord: manter a grafia exata da palavra recebida, sem qualquer alteração.
- usedExcerpt: trecho curto do texto onde a palavra foi usada; null se status="missing".
- explanation: sempre em português do Brasil.
- suggestedCorrection: null apenas quando status="correct"; para todos os outros status, sempre fornecer um exemplo correto em inglês.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_EVAL_STATUSES = new Set<string>([
  'correct',
  'incorrect_spelling',
  'incorrect_usage',
  'missing',
  'forced_usage',
]);

export function parseJsonSafely(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Resposta não contém JSON válido');
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

export function validateEvaluations(
  raw: unknown,
  expectedWords: string[],
): RequiredWordEvaluation[] {
  if (!Array.isArray(raw)) throw new Error('requiredWordEvaluation deve ser um array');
  if (raw.length !== expectedWords.length) {
    throw new Error(`Esperado ${expectedWords.length} avaliações, recebido ${raw.length}`);
  }
  const seen = new Set<string>();
  const result: RequiredWordEvaluation[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new Error('Item inválido na avaliação');
    const ev = item as Record<string, unknown>;
    const word = ev.requiredWord;
    if (typeof word !== 'string' || !word) throw new Error('requiredWord ausente ou inválido');
    if (!expectedWords.includes(word)) throw new Error(`Palavra inesperada: "${word}"`);
    if (seen.has(word)) throw new Error(`Palavra duplicada: "${word}"`);
    seen.add(word);
    const status = ev.status;
    if (typeof status !== 'string' || !VALID_EVAL_STATUSES.has(status)) {
      throw new Error(`Status inválido para "${word}": ${status}`);
    }
    const explanation = ev.explanation;
    if (typeof explanation !== 'string' || !explanation.trim()) {
      throw new Error(`Explicação vazia para "${word}"`);
    }
    result.push({
      requiredWord: word,
      status: status as RequiredWordEvaluationStatus,
      usedExcerpt: typeof ev.usedExcerpt === 'string' ? ev.usedExcerpt : null,
      explanation: explanation.trim(),
      suggestedCorrection: typeof ev.suggestedCorrection === 'string' ? ev.suggestedCorrection : null,
    });
  }
  for (const w of expectedWords) {
    if (!seen.has(w)) throw new Error(`Palavra ausente na avaliação: "${w}"`);
  }
  return result;
}

export function calculateOverallResult(evals: RequiredWordEvaluation[]): 'passed' | 'failed' {
  return evals.every((e) => e.status === 'correct') ? 'passed' : 'failed';
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractReviewMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
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
      // Cached tokens are billed at a discounted rate, not free — the cost
      // calculator prices this separately from the non-cached share of
      // input_text_tokens (see splitCachedInputTokens in cost-calculator.ts).
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  return metrics;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.REVIEW)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de revisão não está configurado.');
  }

  const {
    entryId,
    originalText,
    theme,
    grammarGoal,
    mainTense,
    mode,
    reviewGroupId,
    missionTitle,
    studentLevel,
  } = req.body ?? {};

  if (!originalText || typeof originalText !== 'string' || !originalText.trim()) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'originalText é obrigatório');
  }
  if (originalText.length > 20_000) {
    return jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'O conteúdo enviado é maior que o permitido.');
  }

  if (!await applyRateLimit(res, userId, 'review-text')) return;

  // ── Plan entitlements ────────────────────────────────────────────────────────
  let entitlements;
  try {
    entitlements = await getCurrentUserPlanEntitlements(userId);
  } catch (e) {
    safeLog('review-text', 'entitlements_resolve_failed', 500);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível verificar seu plano. Tente novamente.');
  }
  if (!entitlements.writing.enabled) {
    return jsonError(res, 403, 'FEATURE_DISABLED', ENTITLEMENT_MESSAGES.featureUnavailable);
  }
  const lengthCheck = checkTextLength(originalText, entitlements.writing.maxCharactersPerText, entitlements.writing.maxCharactersUnlimited);
  if (!lengthCheck.allowed) {
    return jsonError(res, 413, lengthCheck.code!, lengthCheck.message!);
  }
  if (!entitlements.writing.reviews.canStart) {
    const code = entitlements.writing.reviews.state === 'monthly_limit_reached' ? 'MONTHLY_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED';
    return jsonError(res, 403, code, ENTITLEMENT_MESSAGES.writingReviewsExhausted);
  }

  const isReviewMode =
    mode === 'review' &&
    typeof reviewGroupId === 'string' &&
    reviewGroupId.length > 0;

  // ── Review mode: verify ownership and load items from DB ──────────────────

  let groupItems: GroupItem[] = [];
  let authorizedRequiredWords: string[] = [];

  if (isReviewMode) {
    const { data: group, error: groupErr } = await supabase
      .from('review_groups')
      .select('id')
      .eq('id', reviewGroupId)
      .single();

    if (groupErr || !group) {
      return res.status(403).json({ error: 'Grupo de revisão não encontrado ou não autorizado' });
    }

    const { data: items, error: itemsErr } = await supabase
      .from('review_group_items')
      .select('id, original_value, corrected_value, explanation, original_sentence')
      .eq('review_group_id', reviewGroupId);

    if (itemsErr || !items || items.length === 0) {
      return res.status(400).json({ error: 'Itens do grupo de revisão não encontrados' });
    }

    groupItems = items as GroupItem[];

    // Derive authoritative required words from DB (deduplicated, ordered)
    const seen = new Set<string>();
    for (const item of groupItems) {
      const w = item.corrected_value.trim();
      if (w && !seen.has(w)) {
        seen.add(w);
        authorizedRequiredWords.push(w);
      }
    }
  }

  // ── Build AI messages ─────────────────────────────────────────────────────

  const systemPrompt = isReviewMode ? REVIEW_SYSTEM_PROMPT : NORMAL_SYSTEM_PROMPT;

  const userMessage = isReviewMode
    ? [
        'Atividade de revisão espaçada.',
        '',
        `Missão: ${missionTitle || '—'}`,
        `Objetivo gramatical: ${grammarGoal || '—'}`,
        `Nível do aluno: ${studentLevel || '—'}`,
        '',
        'Contexto dos erros que o aluno está praticando:',
        ...groupItems.map((item) => {
          let line = `- "${item.original_value}" → "${item.corrected_value}"`;
          if (item.explanation) line += `: ${item.explanation}`;
          if (item.original_sentence) line += ` (contexto: "${item.original_sentence}")`;
          return line;
        }),
        '',
        `Palavras obrigatórias: ${authorizedRequiredWords.join(', ')}`,
        '',
        'Texto do aluno:',
        '"""',
        originalText.trim(),
        '"""',
      ].join('\n')
    : [
        `Tema do dia: ${theme || '—'}`,
        `Objetivo gramatical: ${grammarGoal || '—'}`,
        `Tempo verbal esperado: ${mainTense || '—'}`,
        '',
        'Texto do aluno:',
        '"""',
        originalText.trim(),
        '"""',
      ].join('\n');

  // ── Call AI with retry (up to 3 attempts) ────────────────────────────────

  const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.LONG, maxRetries: 0 });
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userMessage },
  ];

  let feedback: Record<string, unknown> | null = null;
  let lastError = 'Erro desconhecido';

  // ── Gateway context — shared correlationId across retries, attemptNumber ────
  // per physical call. Each physical OpenAI call is its own usage event.
  const deps = getProductionDeps();
  const correlationId = deps.uuidGen();
  const featureKey = isReviewMode ? 'writing.correct_review' : 'writing.correct';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const completion = await executeAiGatewayCall<ChatCompletion>(
        {
          featureKey,
          provider: 'openai',
          service: 'chat.completions',
          model: AI_MODEL,
          userId,
          initiatedByUserId: userId,
          actorType: 'user',
          executionLocation: 'backend',
          correlationId,
          attemptNumber: attempt + 1,
          callSequence: 1,
          resourceType: 'writing_entry',
          resourceId: typeof entryId === 'string' ? entryId : undefined,
          technicalMetadata: {
            endpoint: 'review-text',
            flowType: isReviewMode ? 'review' : 'normal',
            attempt: attempt + 1,
            maxAttempts: 3,
          },
          // Etapa 11 correction — conservative in-memory estimate for
          // enforce-mode reservation sizing; inert in legacy/observe (the
          // only modes this feature runs in). No max_tokens is set on this
          // call, so DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE is used as the
          // output ceiling — a real upper bound, not a precise prediction.
          estimatedMetrics: estimateTextTokens(
            systemPrompt.length + userMessage.length,
            DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
          ),
        },
        () => openai.chat.completions.create({ model: AI_MODEL, messages }),
        deps,
        extractReviewMetrics,
      );
      const raw = completion.choices[0]?.message?.content ?? '';
      const parsed = parseJsonSafely(raw);

      if (isReviewMode) {
        const evaluations = validateEvaluations(parsed.requiredWordEvaluation, authorizedRequiredWords);
        feedback = { ...parsed, requiredWordEvaluation: evaluations };
      } else {
        feedback = parsed;
      }
      break;
    } catch (err) {
      const { code, status } = sanitizeProviderError(err);
      if (code === 'AI_TIMEOUT') {
        safeLog('review-text', 'timeout', status);
        return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
      }
      if (code === 'AI_UNAVAILABLE') {
        safeLog('review-text', 'provider_unavailable', status);
        return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
      }
      lastError = 'Erro de validação';
      if (attempt === 2) {
        return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível processar a revisão. Tente novamente.');
      }
    }
  }

  if (!feedback) {
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível processar a revisão. Tente novamente.');
  }

  const reviewedAt = new Date().toISOString();

  // ── Save to writing_entries (existing behavior, unchanged) ────────────────

  if (entryId) {
    try {
      await supabase
        .from('writing_entries')
        .update({
          corrected_text: feedback.correctedText ?? null,
          ai_score: feedback.score ?? null,
          cefr_level: feedback.level ?? null,
          grammar_score: feedback.grammar ?? null,
          vocabulary_score: feedback.vocabulary ?? null,
          naturalness_score: feedback.naturalness ?? null,
          fluency_score: feedback.fluency ?? null,
          ai_summary: feedback.summary ?? null,
          grammar_feedback: feedback.mainMistakes ?? null,
          ai_main_errors: Array.isArray(feedback.mainMistakes)
            ? feedback.mainMistakes.map((m: any) => m.original)
            : null,
          new_vocabulary: feedback.newVocabulary ?? null,
          natural_expressions: null,
          grammar_goal_achieved: null,
          rewrite_challenge: feedback.nextPractice ?? null,
          reviewed_at: reviewedAt,
          status: 'corrigido',
        })
        .eq('entry_date', entryId)
        .eq('user_id', userId);
    } catch (dbErr) {
      console.error('Supabase update error:', dbErr);
    }
  }

  // ── Save review attempt + apply schedule (review mode only) ─────────────

  let reviewSchedule: Record<string, unknown> | null = null;

  if (isReviewMode && Array.isArray(feedback.requiredWordEvaluation)) {
    const evaluations = feedback.requiredWordEvaluation as RequiredWordEvaluation[];
    const overallResult = calculateOverallResult(evaluations);
    const wordToItemId = new Map(groupItems.map((item) => [item.corrected_value.trim(), item.id]));

    try {
      const { data: attempt, error: attemptErr } = await supabase
        .from('review_attempts')
        .insert({
          user_id: userId,
          review_group_id: reviewGroupId,
          source_entry_date: entryId ?? null,
          submitted_text: originalText.trim(),
          overall_result: overallResult,
        })
        .select('id')
        .single();

      if (attemptErr || !attempt) {
        console.error('Erro ao salvar review_attempt:', attemptErr?.message);
      } else {
        const { error: itemsErr } = await supabase
          .from('review_attempt_items')
          .insert(
            evaluations.map((ev) => ({
              review_attempt_id: attempt.id,
              review_group_item_id: wordToItemId.get(ev.requiredWord) ?? null,
              required_word: ev.requiredWord,
              status: ev.status,
              used_excerpt: ev.usedExcerpt,
              explanation: ev.explanation,
              suggested_correction: ev.suggestedCorrection,
            })),
          );

        if (itemsErr) {
          console.error('Erro ao salvar review_attempt_items:', itemsErr.message);
        }

        // Aplicar agendamento de forma atômica via RPC
        const { data: scheduleData, error: scheduleErr } = await supabase
          .rpc('apply_review_schedule', { p_attempt_id: attempt.id });

        if (scheduleErr) {
          console.error('Erro ao aplicar agendamento:', scheduleErr.message);
        } else {
          reviewSchedule = scheduleData as Record<string, unknown>;
        }
      }
    } catch {
      console.error('Erro ao salvar tentativa de revisão');
    }
  }

  return res.json({ feedback, reviewedAt, reviewSchedule });
}
