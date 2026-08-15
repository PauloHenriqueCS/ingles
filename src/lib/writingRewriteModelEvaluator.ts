/**
 * AI model evaluator for writing rewrite assessment.
 * Called only when deterministic signals are insufficient.
 */

import type { RewriteCorrectionOutcomeStatus, NewIssueCategory } from '../domain/writing-rewrite/rewrite-types';
import type { DeterministicComparisonResult } from './writingRewriteDeterministicComparison';
import { getCurriculumServiceClient } from '../../api/_curriculum/service-client';
import { resolveActivityPrompt, CurriculumConfigError } from '../../api/_curriculum/curriculum-runtime';

export interface ModelEvaluationInput {
  /**
   * The authenticated learner id. Required to resolve the DB-sourced
   * `writing.evaluate_rewrite` prompt (per learning/interface language). Kept
   * optional in the type only so the orchestrator's existing input literal
   * keeps compiling — callModelEvaluator throws an explicit
   * CurriculumConfigError (never a silent English fallback) when it is absent.
   */
  userId?: string;
  originalText: string;
  correctedText: string;
  rewriteText: string;
  mainMistakes: Array<{ mistake: string; correct: string; explanation?: string }>;
  effectiveLevel: string;
  deterministicResult: DeterministicComparisonResult;
}

export interface ModelEvaluationOutput {
  correctionOutcomes: Array<{
    correctionId: string;
    status: RewriteCorrectionOutcomeStatus;
    rewriteExcerpt?: string;
    explanationPtBR: string;
    confidence: number;
    shouldAffectRewriteScore: boolean;
  }>;
  newIssues: Array<{
    category: NewIssueCategory;
    excerpt?: string;
    explanationPtBR: string;
  }>;
  meaningPreservationScore: number;  // 0–100
  clarityImprovementScore: number;   // 0–100
  cohesionImprovementScore: number;  // 0–100
  summaryPtBR: string;
  schemaVersion: string;
  /** Real token usage from the provider response, for AI Gateway telemetry — never estimated. */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ModelEvaluatorConfig {
  provider: string;
  model: string;
  promptVersion: string;
}

const DEFAULT_CONFIG: ModelEvaluatorConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  promptVersion: 'v1',
};

const EVALUATION_SCHEMA_VERSION = 'v1';

const EVALUATE_REWRITE_TEMPLATE_KEY = 'writing.evaluate_rewrite';

/**
 * Formats the identified-mistakes list fed to the evaluation prompt via
 * {{main_mistakes}}. 0-indexed so `correctionId` maps back to the mistake by
 * array position (see writingRewriteOrchestrator.ts). Pedagogical framing lives
 * in the DB template; this only shapes the caller-supplied data.
 */
function formatMainMistakes(mainMistakes: ModelEvaluationInput['mainMistakes']): string {
  const list = mainMistakes
    .map((m, i) => {
      const explanation = m.explanation ? `\n   Explanation: ${m.explanation}` : '';
      return `  ${i}. Original mistake: "${m.mistake}"\n     Correct form: "${m.correct}"${explanation}`;
    })
    .join('\n');
  return list || '  (none listed)';
}

/** Formats the pre-computed deterministic signals fed via {{deterministic_summary}}. */
function formatDeterministicSummary(deterministicResult: DeterministicComparisonResult): string {
  return [
    `Meaning preservation estimate: ${deterministicResult.layerA.meaningPreservationEstimate}%`,
    `Structural similarity to corrected text: ${Math.round(deterministicResult.layerB.structuralSimilarity * 100)}%`,
    `Copy detection assessment: ${deterministicResult.layerB.copyDetection.assessment}`,
    `Estimated correction resolution: ${deterministicResult.estimatedCorrectionResolutionScore}%`,
  ].join('\n');
}

/** The userContext fed to the DB-sourced `writing.evaluate_rewrite` template. */
function buildEvaluationUserContext(input: ModelEvaluationInput): Record<string, string> {
  return {
    effective_level: input.effectiveLevel,
    original_text: input.originalText,
    corrected_text: input.correctedText,
    rewrite_text: input.rewriteText,
    main_mistakes: formatMainMistakes(input.mainMistakes),
    deterministic_summary: formatDeterministicSummary(input.deterministicResult),
  };
}

/**
 * Rough token-estimation proxy for the evaluation call (used by the gateway
 * reservation estimator in writingRewriteOrchestrator.ts). Deliberately holds
 * NO pedagogical taxonomy — that now lives entirely in the DB template. It
 * concatenates the same data that fills the template's placeholders so the
 * estimated size tracks the real input size. The authoritative prompt is
 * resolved from the database inside callModelEvaluator.
 */
export function buildRewriteEvaluationPrompt(input: ModelEvaluationInput): string {
  const ctx = buildEvaluationUserContext(input);
  return Object.values(ctx).join('\n');
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'corrected',
  'partially_corrected',
  'unchanged',
  'valid_alternative',
  'worsened',
  'not_applicable',
]);

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  'regression',
  'new_grammar_error',
  'new_vocabulary_error',
  'new_word_order_error',
  'new_clarity_problem',
  'meaning_changed',
  'task_deviation',
]);

/** Parse and validate model JSON output. Throws if schema is invalid. */
export function parseModelEvaluationOutput(raw: string): ModelEvaluationOutput {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Model output is not valid JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.correctionOutcomes)) {
    throw new Error('Model output missing correctionOutcomes array');
  }

  if (!Array.isArray(parsed.newIssues)) {
    throw new Error('Model output missing newIssues array');
  }

  const correctionOutcomes = (parsed.correctionOutcomes as Record<string, unknown>[]).map(
    (o, idx) => {
      const status = o.status as string;
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`Invalid status "${status}" at correctionOutcomes[${idx}]`);
      }
      return {
        correctionId: String(o.correctionId ?? idx),
        status: status as RewriteCorrectionOutcomeStatus,
        rewriteExcerpt: o.rewriteExcerpt as string | undefined,
        explanationPtBR: String(o.explanationPtBR ?? ''),
        confidence: Math.min(1, Math.max(0, Number(o.confidence ?? 0.5))),
        shouldAffectRewriteScore: Boolean(o.shouldAffectRewriteScore ?? true),
      };
    },
  );

  const newIssues = (parsed.newIssues as Record<string, unknown>[]).map((issue, idx) => {
    const category = issue.category as string;
    if (!VALID_CATEGORIES.has(category)) {
      throw new Error(`Invalid category "${category}" at newIssues[${idx}]`);
    }
    return {
      category: category as NewIssueCategory,
      excerpt: issue.excerpt as string | undefined,
      explanationPtBR: String(issue.explanationPtBR ?? ''),
    };
  });

  return {
    correctionOutcomes,
    newIssues,
    meaningPreservationScore: Math.min(100, Math.max(0, Number(parsed.meaningPreservationScore ?? 50))),
    clarityImprovementScore: Math.min(100, Math.max(0, Number(parsed.clarityImprovementScore ?? 50))),
    cohesionImprovementScore: Math.min(100, Math.max(0, Number(parsed.cohesionImprovementScore ?? 50))),
    summaryPtBR: String(parsed.summaryPtBR ?? ''),
    schemaVersion: String(parsed.schemaVersion ?? EVALUATION_SCHEMA_VERSION),
  };
}

/**
 * Call the AI model for semantic evaluation.
 * Uses OpenAI API with response_format: json_object.
 * Timeout: 45 seconds.
 *
 * The prompt is DB-sourced (writing.evaluate_rewrite template, per learning/
 * interface language) — there is NO hardcoded English fallback. Rewrite
 * evaluation is NOT part of curricular progression, so the template is resolved
 * with requireSubtopic:false and NO practice is recorded. A missing template,
 * an empty required placeholder, or a missing userId throws
 * CurriculumConfigError, which the orchestrator surfaces as an explicit
 * evaluation failure.
 */
export async function callModelEvaluator(
  input: ModelEvaluationInput,
  apiKey: string,
  config?: Partial<ModelEvaluatorConfig>,
): Promise<ModelEvaluationOutput> {
  const effectiveConfig: ModelEvaluatorConfig = { ...DEFAULT_CONFIG, ...config };

  if (!input.userId) {
    throw new CurriculumConfigError(
      'callModelEvaluator requires input.userId to resolve the writing.evaluate_rewrite prompt',
    );
  }

  const resolved = await resolveActivityPrompt(getCurriculumServiceClient(), input.userId, {
    templateKey: EVALUATE_REWRITE_TEMPLATE_KEY,
    activityType: 'writing',
    requireSubtopic: false,
    userContext: buildEvaluationUserContext(input),
  });
  const systemPrompt = resolved.system;
  const userPrompt = resolved.user ?? '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: effectiveConfig.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(unreadable)');
    // Surface the numeric HTTP status and the STRUCTURED OpenAI error code on the
    // thrown error (not just inside the message string) so the gateway's
    // sanitizeError() records a real http_status/error_code and the operational-
    // alert classifier can recognise auth (401/403), rate-limit (429), server
    // (5xx), and — critically — a billing/quota block (e.g. insufficient_quota).
    // Previously the status lived only in the message, so every OpenAI HTTP
    // failure here classified as NULL and raised no alert.
    const err = new Error(`Model evaluator API error ${response.status}`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = response.status;
    try {
      const parsed = JSON.parse(errorBody) as { error?: { code?: unknown; type?: unknown } };
      const rawCode = parsed?.error?.code ?? parsed?.error?.type;
      if (typeof rawCode === 'string' && rawCode.trim()) err.code = rawCode.trim().slice(0, 64);
    } catch { /* non-JSON body → no structured code */ }
    throw err;
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Model evaluator returned empty content');
  }

  const parsed = parseModelEvaluationOutput(content);
  const usage = body?.usage;
  if (usage?.prompt_tokens != null && usage?.completion_tokens != null) {
    parsed.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
  }
  return parsed;
}
