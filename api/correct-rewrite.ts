import OpenAI from 'openai';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';

const AI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are an expert English writing coach for Brazilian adult learners.

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

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.REVIEW)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { userId } = auth;
  if (!await applyRateLimit(res, userId, 'correct-rewrite')) return;

  const { rewriteText, originalCorrectedText, studentLevel } = req.body ?? {};

  if (typeof rewriteText !== 'string' || !rewriteText.trim()) {
    safeLog('correct-rewrite', 'invalid_request', 400, { reason: 'missing_rewrite_text' });
    jsonError(res, 400, 'INVALID_REQUEST', 'rewriteText é obrigatório.');
    return;
  }
  if (typeof originalCorrectedText !== 'string' || !originalCorrectedText.trim()) {
    safeLog('correct-rewrite', 'invalid_request', 400, { reason: 'missing_corrected_text' });
    jsonError(res, 400, 'INVALID_REQUEST', 'originalCorrectedText é obrigatório.');
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    safeLog('correct-rewrite', 'config_error', 500, { reason: 'missing_api_key' });
    jsonError(res, 500, 'INTERNAL_ERROR', 'Serviço de IA não configurado.');
    return;
  }

  const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });

  const userPrompt = `Reference (AI correction of student's first draft):
"""
${originalCorrectedText.trim()}
"""

Student's Version 2 (to be corrected):
"""
${rewriteText.trim()}
"""
${studentLevel ? `\nStudent level: ${studentLevel}` : ''}

Produce the final corrected version of Version 2 now:`;

  let finalCorrectedText: string | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
      });

      const raw = (completion.choices[0]?.message?.content ?? '').trim();
      if (!raw) throw new Error('Resposta vazia da IA');
      finalCorrectedText = raw;

      safeLog('correct-rewrite', 'success', 200, {
        attempt,
        inputLen: rewriteText.length,
        outputLen: raw.length,
      });
      break;
    } catch (err) {
      const { code, status } = sanitizeProviderError(err);
      safeLog('correct-rewrite', 'ai_error', status, { attempt, code });
      if (code === 'AI_TIMEOUT' || code === 'AI_UNAVAILABLE') {
        jsonError(res, status, code, 'Serviço de IA temporariamente indisponível. Tente novamente.');
        return;
      }
    }
  }

  if (!finalCorrectedText) {
    jsonError(res, 503, 'AI_UNAVAILABLE', 'Não foi possível gerar a versão final. Tente novamente.');
    return;
  }

  res.status(200).json({ finalCorrectedText });
}
