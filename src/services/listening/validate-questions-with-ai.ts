import type { ValidatedGeneratedQuestion, QuestionAIValidationResult } from './listening-question-schema';
import type { BlockData } from './build-listening-question-prompt';
import { VALIDATOR_SYSTEM_PROMPT, buildValidatorUserPrompt, VALIDATOR_PROMPT_VERSION } from './build-listening-question-prompt';
import type { CEFRLevel } from '../../domain/curriculum/cefr';

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface AICallResult {
  text: string;
  usage: AIUsage;
  requestId: string | null;
}

/**
 * Optional per-call overrides. Omitted entirely by every existing caller
 * (question validation, etc.) — a callAI implementation that only reads its
 * first two parameters remains a valid AICallWithUsageFn either way, so
 * adding this never requires touching call sites that don't need it.
 */
export interface AICallOptions {
  temperature?: number;
  jsonMode?: boolean;
}

export type AICallWithUsageFn = (systemPrompt: string, userPrompt: string, options?: AICallOptions) => Promise<AICallResult>;

export { VALIDATOR_PROMPT_VERSION };

const MIN_CONFIDENCE_DEFAULT = 0.85;

export interface ValidateWithAIOptions {
  minConfidence?: number;
}

function parseValidatorResponse(rawText: string, questionOrder: number): QuestionAIValidationResult {
  const trimmed = rawText.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        schemaVersion: '1.0',
        valid: false,
        confidence: 0,
        checks: {
          answerSupported: false,
          singleCorrectOption: false,
          distractorsPlausible: false,
          levelAppropriate: false,
          evidenceValid: false,
          noExternalKnowledge: false,
          notAmbiguous: false,
        },
        issues: [`Validator returned non-JSON for question ${questionOrder}`],
        suggestedCorrection: null,
      };
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return {
        schemaVersion: '1.0',
        valid: false,
        confidence: 0,
        checks: {
          answerSupported: false,
          singleCorrectOption: false,
          distractorsPlausible: false,
          levelAppropriate: false,
          evidenceValid: false,
          noExternalKnowledge: false,
          notAmbiguous: false,
        },
        issues: [`Failed to parse validator JSON for question ${questionOrder}`],
        suggestedCorrection: null,
      };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      schemaVersion: '1.0',
      valid: false,
      confidence: 0,
      checks: {
        answerSupported: false,
        singleCorrectOption: false,
        distractorsPlausible: false,
        levelAppropriate: false,
        evidenceValid: false,
        noExternalKnowledge: false,
        notAmbiguous: false,
      },
      issues: [`Validator response is not an object for question ${questionOrder}`],
      suggestedCorrection: null,
    };
  }

  const r = parsed as Record<string, unknown>;
  const checks = (r.checks && typeof r.checks === 'object') ? r.checks as Record<string, unknown> : {};

  return {
    schemaVersion: typeof r.schemaVersion === 'string' ? r.schemaVersion : '1.0',
    valid: r.valid === true,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    checks: {
      answerSupported: checks.answerSupported === true,
      singleCorrectOption: checks.singleCorrectOption === true,
      distractorsPlausible: checks.distractorsPlausible === true,
      levelAppropriate: checks.levelAppropriate === true,
      evidenceValid: checks.evidenceValid === true,
      noExternalKnowledge: checks.noExternalKnowledge === true,
      notAmbiguous: checks.notAmbiguous === true,
    },
    issues: Array.isArray(r.issues) ? r.issues.filter((i): i is string => typeof i === 'string') : [],
    suggestedCorrection: r.suggestedCorrection ?? null,
  };
}

function isResultValid(result: QuestionAIValidationResult, minConfidence: number): boolean {
  const { checks, confidence } = result;
  return (
    checks.answerSupported &&
    checks.singleCorrectOption &&
    checks.distractorsPlausible &&
    checks.levelAppropriate &&
    checks.evidenceValid &&
    checks.noExternalKnowledge &&
    checks.notAmbiguous &&
    confidence >= minConfidence
  );
}

export async function validateQuestionWithAI(
  question: ValidatedGeneratedQuestion,
  block: BlockData,
  cefrLevel: CEFRLevel,
  callAI: AICallWithUsageFn,
  episodeId: string,
  opts: ValidateWithAIOptions = {},
): Promise<QuestionAIValidationResult> {
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE_DEFAULT;
  const userPrompt = buildValidatorUserPrompt({ question, block, cefrLevel });

  const { text, usage } = await callAI(VALIDATOR_SYSTEM_PROMPT, userPrompt);

  console.error(JSON.stringify({
    event: 'listening_question_token_usage',
    stage: 'listening_question_validation',
    provider: 'openai',
    promptVersion: VALIDATOR_PROMPT_VERSION,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: usage.durationMs,
    episodeId,
    questionOrder: question.questionOrder,
    t: Date.now(),
  }));

  const result = parseValidatorResponse(text, question.questionOrder);
  result.valid = isResultValid(result, minConfidence);
  return result;
}

export async function validateAllQuestionsWithAI(
  questions: [ValidatedGeneratedQuestion, ValidatedGeneratedQuestion],
  blocks: [BlockData, BlockData],
  cefrLevel: CEFRLevel,
  callAI: AICallWithUsageFn,
  episodeId: string,
  opts: ValidateWithAIOptions = {},
): Promise<[QuestionAIValidationResult, QuestionAIValidationResult]> {
  const r1 = await validateQuestionWithAI(
    questions[0],
    blocks.find(b => b.blockOrder === questions[0].blockOrder)!,
    cefrLevel,
    callAI,
    episodeId,
    opts,
  );
  const r2 = await validateQuestionWithAI(
    questions[1],
    blocks.find(b => b.blockOrder === questions[1].blockOrder)!,
    cefrLevel,
    callAI,
    episodeId,
    opts,
  );
  return [r1, r2];
}
