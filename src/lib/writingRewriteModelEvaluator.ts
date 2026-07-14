/**
 * AI model evaluator for writing rewrite assessment.
 * Called only when deterministic signals are insufficient.
 */

import type { RewriteCorrectionOutcomeStatus, NewIssueCategory } from '../domain/writing-rewrite/rewrite-types';
import type { DeterministicComparisonResult } from './writingRewriteDeterministicComparison';

export interface ModelEvaluationInput {
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

/** Build the evaluation prompt for the AI model. */
export function buildRewriteEvaluationPrompt(input: ModelEvaluationInput): string {
  const mistakesList = input.mainMistakes
    .map((m, i) => {
      const explanation = m.explanation ? `\n   Explanation: ${m.explanation}` : '';
      return `  ${i}. Original mistake: "${m.mistake}"\n     Correct form: "${m.correct}"${explanation}`;
    })
    .join('\n');

  const deterministicSummary = [
    `Meaning preservation estimate: ${input.deterministicResult.layerA.meaningPreservationEstimate}%`,
    `Structural similarity to corrected text: ${Math.round(input.deterministicResult.layerB.structuralSimilarity * 100)}%`,
    `Copy detection assessment: ${input.deterministicResult.layerB.copyDetection.assessment}`,
    `Estimated correction resolution: ${input.deterministicResult.estimatedCorrectionResolutionScore}%`,
  ].join('\n');

  return `You are an expert English language teacher evaluating a learner's rewrite attempt.

The learner's CEFR level is: ${input.effectiveLevel}

## ORIGINAL TEXT (learner's initial production)
${input.originalText}

## CORRECTED TEXT (AI-generated correction)
${input.correctedText}

## LEARNER'S REWRITE (new attempt after seeing the correction)
${input.rewriteText}

## MISTAKES THAT WERE IDENTIFIED (from the original)
${mistakesList || '  (none listed)'}

## DETERMINISTIC ANALYSIS (pre-computed signals)
${deterministicSummary}

## INSTRUCTIONS

Evaluate the learner's rewrite and return a valid JSON object with exactly this structure:

{
  "correctionOutcomes": [
    {
      "correctionId": "0",
      "status": "<corrected|partially_corrected|unchanged|valid_alternative|worsened|not_applicable>",
      "rewriteExcerpt": "<relevant excerpt from rewrite, or omit>",
      "explanationPtBR": "<explanation in Portuguese, 1–2 sentences>",
      "confidence": <0.0 to 1.0>,
      "shouldAffectRewriteScore": <true|false>
    }
  ],
  "newIssues": [
    {
      "category": "<regression|new_grammar_error|new_vocabulary_error|new_word_order_error|new_clarity_problem|meaning_changed|task_deviation>",
      "excerpt": "<relevant excerpt, or omit>",
      "explanationPtBR": "<explanation in Portuguese>"
    }
  ],
  "meaningPreservationScore": <0–100>,
  "clarityImprovementScore": <0–100>,
  "cohesionImprovementScore": <0–100>,
  "summaryPtBR": "<2–3 sentence summary in Portuguese>",
  "schemaVersion": "v1"
}

## EVALUATION RULES

For each mistake listed (indexed 0, 1, 2, ...):
- "corrected": The learner clearly fixed this issue independently.
- "partially_corrected": The learner made progress but the fix is incomplete.
- "unchanged": The same error appears in the rewrite.
- "valid_alternative": The learner used a different but grammatically valid expression.
- "worsened": The learner's attempt made the original error worse.
- "not_applicable": The rewrite restructured the sentence so the correction is irrelevant.

IMPORTANT:
- Do NOT penalize valid contractions (it's, don't, I'm) — they are equally correct.
- Do NOT penalize legitimate word order changes that preserve meaning.
- Do NOT penalize synonyms or paraphrases that preserve meaning and are grammatically correct.
- Accept valid reformulations and alternative phrasings as "valid_alternative".
- List only NEW issues (errors not present in the original) in "newIssues".
- If there are no new issues, return an empty array.

For scores:
- meaningPreservationScore (0–100): How well does the rewrite preserve the original meaning?
- clarityImprovementScore (0–100): Is the rewrite clearer than the original? (50 = same, 0–49 = worse, 51–100 = better)
- cohesionImprovementScore (0–100): Is the rewrite more cohesive? (50 = same)

Write the summaryPtBR in Brazilian Portuguese in 2–3 sentences, focusing on what the learner did well and what still needs work.

Return ONLY valid JSON. No markdown, no explanation outside the JSON.`;
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
 */
export async function callModelEvaluator(
  input: ModelEvaluationInput,
  apiKey: string,
  config?: Partial<ModelEvaluatorConfig>,
): Promise<ModelEvaluationOutput> {
  const effectiveConfig: ModelEvaluatorConfig = { ...DEFAULT_CONFIG, ...config };
  const prompt = buildRewriteEvaluationPrompt(input);

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
            role: 'user',
            content: prompt,
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
    throw new Error(`Model evaluator API error ${response.status}: ${errorBody.slice(0, 300)}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Model evaluator returned empty content');
  }

  return parseModelEvaluationOutput(content);
}
