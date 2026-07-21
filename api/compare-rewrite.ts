import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens, DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';
import { getCurrentUserPlanEntitlements } from './_entitlements/plan-entitlements-service';
import { checkFeatureConfigError } from './_entitlements/require-feature-access';
import { ENTITLEMENT_MESSAGES } from '../src/domain/entitlements/entitlement-messages';

const AI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT_COMPARE = `Você é um professor de inglês para brasileiros adultos iniciantes.

O aluno escreveu um texto em inglês, recebeu uma correção e depois tentou criar uma segunda versão corrigindo os próprios erros.

Sua tarefa é comparar:
1. o texto original;
2. o texto corrigido de referência;
3. a versão 2 escrita pelo aluno;
4. os principais erros apontados na primeira revisão.

Avalie se o aluno realmente melhorou o texto.

Você deve responder em português do Brasil, exceto nos exemplos em inglês.

Seja didático, direto e encorajador.
Não humilhe o aluno.
Não diga apenas que está certo ou errado.
Explique o que melhorou e o que ainda precisa ser treinado.

Retorne somente JSON válido.
Não use markdown.
Não escreva nada antes ou depois do JSON.

Formato obrigatório:

{
  "improvementScore": number,
  "fixedMistakesCount": number,
  "remainingMistakesCount": number,
  "fixedMistakes": [
    {
      "mistake": string,
      "original": string,
      "rewrite": string,
      "feedback": string
    }
  ],
  "remainingMistakes": [
    {
      "mistake": string,
      "rewrite": string,
      "correct": string,
      "feedback": string
    }
  ],
  "newIssues": [
    {
      "issue": string,
      "rewrite": string,
      "suggestion": string
    }
  ],
  "overallFeedback": string,
  "nextAction": string
}

Regras:
- improvementScore deve ir de 0 a 100.
- fixedMistakesCount deve indicar quantos erros da primeira revisão foram corrigidos na versão 2.
- remainingMistakesCount deve indicar quantos erros ainda permaneceram.
- fixedMistakes deve listar erros que o aluno conseguiu corrigir.
- remainingMistakes deve listar erros que o aluno ainda não corrigiu.
- newIssues deve listar novos problemas criados na versão 2, se existirem.
- overallFeedback deve resumir a evolução da versão 1 para a versão 2.
- nextAction deve sugerir uma tarefa curta para fixar o aprendizado.
- Se a versão 2 for muito semelhante ao texto corrigido de referência, diga de forma gentil que parece ter sido copiada e incentive o aluno a tentar escrever com as próprias palavras.
- Se a versão 2 for idêntica ao texto original, diga que ainda não houve melhora suficiente e oriente o aluno a focar nos erros apontados.
- Se a versão 2 estiver melhor, reconheça claramente a melhora.
- Se a versão 2 tiver menos erros mas ainda não estiver perfeita, valorize o progresso e explique o próximo ajuste.
- Não reescrever o texto inteiro para o aluno.`;

const SYSTEM_PROMPT_CORRECT = `You are an expert English writing coach for Brazilian adult learners.

Your task: produce a clean, final corrected version of a student's rewritten text.

Context:
- The student received AI feedback on their first draft and saw a corrected version.
- They wrote a second version (Version 2) trying to fix the errors on their own.
- You must now correct any remaining issues in the student's Version 2.

Rules:
- Fix ALL grammatical errors, unnatural phrasing, and vocabulary mistakes in the student's Version 2.
- Preserve the student's original meaning, ideas, and voice as closely as possible.
- Keep similar length and structure — do not expand, summarize, or add new ideas.
- Do NOT replace the text with a completely different composition.
- Use natural English appropriate to the student's level.
- Output ONLY the corrected text. No labels, no explanations, no markdown, no preamble, no postamble.`;

function buildUserMessage(
  originalText: string,
  correctedText: string,
  rewriteText: string,
  mainMistakes: { original: string; correct: string; explanation: string }[]
): string {
  const lines: string[] = [];
  lines.push('=== TEXTO ORIGINAL DO ALUNO ===');
  lines.push(originalText.trim());
  lines.push('');
  lines.push('=== TEXTO CORRIGIDO DE REFERÊNCIA ===');
  lines.push(correctedText.trim());
  lines.push('');
  lines.push('=== VERSÃO 2 ESCRITA PELO ALUNO ===');
  lines.push(rewriteText.trim());
  lines.push('');
  if (mainMistakes.length > 0) {
    lines.push('=== PRINCIPAIS ERROS DA PRIMEIRA REVISÃO ===');
    mainMistakes.forEach((m, i) => {
      lines.push(`${i + 1}. Você escreveu: "${m.original}" → Correto: "${m.correct}"`);
      if (m.explanation) lines.push(`   Explicação: ${m.explanation}`);
    });
  }
  return lines.join('\n');
}

function buildFinalCorrectionPrompt(rewriteText: string, correctedText: string): string {
  return `Reference (AI correction of student's first draft):
"""
${correctedText.trim()}
"""

Student's Version 2 (to be corrected):
"""
${rewriteText.trim()}
"""

Produce the final corrected version of Version 2 now:`;
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
  const { userId } = auth;

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de comparação não está configurado.');

  const { originalText, correctedText, rewriteText, mainMistakes, generateFinalTextOnly } = req.body ?? {};

  // ── Mode: generate final corrected text only (for old records with V2 but no final text)
  if (generateFinalTextOnly === true) {
    if (!correctedText?.trim() || !rewriteText?.trim()) {
      return jsonError(res, 400, 'INVALID_REQUEST', 'correctedText e rewriteText são obrigatórios.');
    }
    if (!await applyRateLimit(res, userId, 'compare-rewrite')) return;

    // ── Gateway context — created only once auth/validation/rate-limit have
    // passed, so an early rejection never depends on gateway infrastructure
    // (mirrors review-text.ts / generate-theme.ts). This is its own HTTP
    // request, so it gets its own fresh correlationId.
    const gatewayDeps = getProductionDeps();
    const correlationId = gatewayDeps.uuidGen();
    let physicalAttempt = 0;

    try {
      const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });
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
            SYSTEM_PROMPT_CORRECT.length + buildFinalCorrectionPrompt(rewriteText, correctedText).length,
            DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
          ),
        },
        () => openai.chat.completions.create({
          model: AI_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_CORRECT },
            { role: 'user', content: buildFinalCorrectionPrompt(rewriteText, correctedText) },
          ],
        }),
        gatewayDeps,
        extractCompareMetrics,
      );
      const finalCorrectedText = (completion.choices[0]?.message?.content ?? '').trim();
      if (!finalCorrectedText) throw new Error('Resposta vazia');
      safeLog('compare-rewrite', 'final_only_success', 200);
      return res.json({ finalCorrectedText });
    } catch (err) {
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

  if (!await applyRateLimit(res, userId, 'compare-rewrite')) return;

  // ── Gateway context — one correlationId per HTTP request, one physical-
  // attempt counter shared across both physical calls made below (comparison
  // then, best-effort, final correction). Created only after auth/validation/
  // rate-limit have passed (mirrors review-text.ts / generate-theme.ts).
  const gatewayDeps = getProductionDeps();
  const correlationId = gatewayDeps.uuidGen();
  let physicalAttempt = 0;

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
          SYSTEM_PROMPT_COMPARE.length + buildUserMessage(
            originalText, correctedText, rewriteText, Array.isArray(mainMistakes) ? mainMistakes : [],
          ).length,
          DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
        ),
      },
      () => openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_COMPARE },
          {
            role: 'user',
            content: buildUserMessage(
              originalText,
              correctedText,
              rewriteText,
              Array.isArray(mainMistakes) ? mainMistakes : []
            ),
          },
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
      if (!match) return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      try { parsed = JSON.parse(match[0]); }
      catch { return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' }); }
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
            SYSTEM_PROMPT_CORRECT.length + buildFinalCorrectionPrompt(rewriteText, correctedText).length,
            DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
          ),
        },
        () => openai.chat.completions.create({
          model: AI_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT_CORRECT },
            { role: 'user', content: buildFinalCorrectionPrompt(rewriteText, correctedText) },
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

    safeLog('compare-rewrite', 'success', 200, { hasFinalText: finalCorrectedText !== undefined });
    return res.json({ result, ...(finalCorrectedText ? { finalCorrectedText } : {}) });
  } catch (err) {
    const { code, status } = sanitizeProviderError(err);
    if (code === 'AI_TIMEOUT') {
      safeLog('compare-rewrite', 'timeout', status);
      return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
    }
    safeLog('compare-rewrite', 'provider_error', status);
    return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
  }
}
