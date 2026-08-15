/**
 * SERVER-ONLY. The C2 gate AI evaluator: composes the DB-sourced prompt
 * (prompt_templates + the rubric criteria), calls OpenAI, and returns the raw
 * score object for server-side validation. Never trusts the model's total or
 * free text — the runtime validates scores against the rubric and computes the
 * total/decision itself (see placement-engine.validateAndScoreC2 / c2Decision).
 *
 * Mirrors the existing house pattern (api/review-text.ts, grammar-explanation):
 * OpenAI SDK, maxRetries:0 (own retry loop), parseJson, sanitizeProviderError.
 */
import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TIMEOUTS, sanitizeProviderError, safeLog } from '../_helpers';
import type { C2Evaluator, C2EvaluatorInput, C2EvaluatorResult } from './placement-runtime';

const MAX_ATTEMPTS = 3;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

interface TemplateRow {
  system_body: string;
  user_body: string | null;
  model: string | null;
  temperature: number | null;
}

function formatRubric(criteriaRaw: unknown[]): string {
  const lines: string[] = [];
  for (const c of criteriaRaw as Array<Record<string, any>>) {
    lines.push(`- ${c.key} (${c.label ?? c.key}) [0..${c.max_score}]`);
    const d = c.descriptors ?? {};
    for (const score of ['0', '1', '2']) {
      if (d[score]) lines.push(`    ${score}: ${d[score]}`);
    }
  }
  return lines.join('\n');
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

/**
 * Builds a real evaluator bound to a service client. The prompt lives in the DB
 * (template_key from the rubric); a missing template is an explicit config error.
 */
export function makeC2Evaluator(service: SupabaseClient, apiKey: string): C2Evaluator {
  return async (input: C2EvaluatorInput): Promise<C2EvaluatorResult> => {
    const { data: tplRow } = await service
      .from('prompt_templates')
      .select('system_body, user_body, model, temperature')
      .eq('template_key', input.promptTemplateKey)
      .eq('status', 'published')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const tpl = (tplRow ?? null) as TemplateRow | null;
    if (!tpl) return { ok: false, code: 'CONFIG_ERROR' };

    const vars: Record<string, string> = {
      task_manager: input.taskManager,
      task_friend: input.taskFriend,
      response_manager: input.responseManager,
      response_friend: input.responseFriend,
      rubric_criteria: formatRubric(input.criteriaRaw),
    };
    const system = fill(tpl.system_body, vars);
    const user = tpl.user_body ? fill(tpl.user_body, vars) : 'Avalie e responda apenas com o JSON pedido.';
    const model = tpl.model ?? 'gpt-4o-mini';

    const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });

    let lastCode = 'AI_UNAVAILABLE';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const completion = await openai.chat.completions.create({
          model,
          temperature: tpl.temperature ?? 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        const raw = completion.choices[0]?.message?.content ?? '';
        const parsed = parseJson(raw);
        if (!parsed || typeof parsed !== 'object') {
          lastCode = 'INVALID_JSON';
          continue; // retry — a malformed body may succeed next attempt
        }
        const reasonCodes = Array.isArray((parsed as any).reason_codes)
          ? ((parsed as any).reason_codes as unknown[]).map((x) => String(x)).slice(0, 10)
          : [];
        return {
          ok: true,
          rawScores: parsed,
          reasonCodes,
          model,
          provider: 'openai',
          raw: parsed,
        };
      } catch (err) {
        const { code } = sanitizeProviderError(err);
        lastCode = code;
        safeLog('placement-c2', 'provider_error', 0, { attempt, code });
        // Transient — retry unless it was the last attempt.
      }
    }
    return { ok: false, code: lastCode };
  };
}
