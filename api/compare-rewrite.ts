import OpenAI from 'openai';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';

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

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.COMPARE)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de comparação não está configurado.');

  const { originalText, correctedText, rewriteText, mainMistakes, generateFinalTextOnly } = req.body ?? {};

  // ── Mode: generate final corrected text only (for old records with V2 but no final text)
  if (generateFinalTextOnly === true) {
    if (!correctedText?.trim() || !rewriteText?.trim()) {
      return jsonError(res, 400, 'INVALID_REQUEST', 'correctedText e rewriteText são obrigatórios.');
    }
    if (!await applyRateLimit(res, userId, 'compare-rewrite')) return;

    try {
      const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_CORRECT },
          { role: 'user', content: buildFinalCorrectionPrompt(rewriteText, correctedText) },
        ],
      });
      const finalCorrectedText = (completion.choices[0]?.message?.content ?? '').trim();
      if (!finalCorrectedText) throw new Error('Resposta vazia');
      safeLog('compare-rewrite', 'final_only_success', 200, null);
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

  try {
    const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });

    const completion = await openai.chat.completions.create({
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
    });

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
      const correction = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_CORRECT },
          { role: 'user', content: buildFinalCorrectionPrompt(rewriteText, correctedText) },
        ],
      });
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
