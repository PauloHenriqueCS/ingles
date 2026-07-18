import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../domain/curriculum/cefr';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens } from '../../../api/_ai-gateway/index';
import type { GatewayUsageMetric } from '../../../api/_ai-gateway/index';
import {
  BLOCK1_SYSTEM_PROMPT, BLOCK2_SYSTEM_PROMPT,
  EXPAND_BLOCK_SYSTEM_PROMPT, CONDENSE_BLOCK_SYSTEM_PROMPT,
  PROMPT_VERSION, CONTENT_VERSION,
  buildBlock1UserPrompt, buildBlock2UserPrompt,
  buildExpandBlockUserPrompt, buildCondenseBlockUserPrompt,
} from './build-listening-story-prompt';
import type { Block1Context } from './build-listening-story-prompt';
import {
  parseStoryJson,
  validateBlock1AIResponse, validateTextEnResponse,
  StoryParseError, StoryValidationError,
} from './validate-listening-story';
import { segmentListeningText, SentenceSegmentationError } from './segment-listening-story-text';
import { persistListeningStory, StoryPersistError } from './persist-listening-story';
import { WORD_COUNT_RANGES } from './listening-level-config';
import type { ValidatedStory, ValidatedBlock } from './listening-story-schema';

export { StoryParseError, StoryValidationError, StoryPersistError };

export class StoryAITimeoutError extends Error {
  readonly code = 'STORY_AI_TIMEOUT';
  constructor() {
    super('AI call timed out generating listening story');
    this.name = 'StoryAITimeoutError';
  }
}

export class StoryAIUnavailableError extends Error {
  readonly code = 'STORY_AI_UNAVAILABLE';
  constructor(message = 'AI service unavailable') {
    super(message);
    this.name = 'StoryAIUnavailableError';
  }
}

export class StoryOutputTruncatedError extends Error {
  readonly code = 'STORY_OUTPUT_TRUNCATED';
  readonly retryable = true;
  constructor(readonly model: string, readonly responseChars: number) {
    super(`AI response was truncated (finish_reason: length, chars: ${responseChars}, model: ${model})`);
    this.name = 'StoryOutputTruncatedError';
  }
}

export class StoryBlock1TooShortError extends Error {
  readonly code = 'STORY_BLOCK_1_TOO_SHORT';
  constructor(readonly wordCount: number, readonly minWords: number) {
    super(`Block 1 has ${wordCount} words, minimum is ${minWords}`);
    this.name = 'StoryBlock1TooShortError';
  }
}

export class StoryBlock2TooShortError extends Error {
  readonly code = 'STORY_BLOCK_2_TOO_SHORT';
  constructor(readonly wordCount: number, readonly minWords: number) {
    super(`Block 2 has ${wordCount} words, minimum is ${minWords}`);
    this.name = 'StoryBlock2TooShortError';
  }
}

export class StoryBlockTooLongError extends Error {
  readonly code = 'STORY_BLOCK_TOO_LONG';
  constructor(readonly blockNum: 1 | 2, readonly wordCount: number, readonly maxWords: number) {
    super(`Block ${blockNum} has ${wordCount} words, maximum is ${maxWords}`);
    this.name = 'StoryBlockTooLongError';
  }
}

const AI_MODEL = 'gpt-4o';
const STORY_TIMEOUT_MS = 90_000;
const MAX_BLOCK_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 1600;

export interface GenerateStoryOptions {
  cefrLevel: CEFRLevel;
  theme?: string | null;
  seed?: string | null;
  dryRun?: boolean;
}

export interface GenerateStoryResult {
  story: ValidatedStory;
  /** null when dryRun = true */
  episodeId: string | null;
  idempotencyKey: string;
}

export type AICallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export function buildIdempotencyKey(opts: Pick<GenerateStoryOptions, 'cefrLevel' | 'theme' | 'seed'>): string {
  return [opts.cefrLevel, opts.theme ?? '', opts.seed ?? '', PROMPT_VERSION, String(CONTENT_VERSION)].join('|');
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; constructor?: { name?: string } };
  return (
    e.name === 'AbortError' ||
    e.message === 'timeout' ||
    (e.constructor?.name ?? '').includes('Timeout')
  );
}

function isUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

function handleAIError(err: unknown): never {
  if (isTimeoutError(err)) throw new StoryAITimeoutError();
  if (isUnavailableError(err)) throw new StoryAIUnavailableError();
  throw new StoryAIUnavailableError(`AI call failed: ${String(err)}`);
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractEpisodeStoryMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
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

export function createDefaultAICallFn(apiKey: string): AICallFn {
  const client = new OpenAI({ apiKey, timeout: STORY_TIMEOUT_MS, maxRetries: 0 });
  // Lazy: getProductionDeps() (and the Supabase client it constructs) must not
  // run just because this factory was created — only when a physical call is
  // actually about to happen. Callers build this closure via `callAI ??
  // createDefaultAICallFn(...)`, which evaluates eagerly even on paths that
  // never end up invoking it (dry-run, idempotent early-return).
  let gatewayDeps: ReturnType<typeof getProductionDeps> | undefined;
  let correlationId: string | undefined;
  let physicalAttempt = 0;

  return async (systemPrompt: string, userPrompt: string) => {
    if (!gatewayDeps) {
      gatewayDeps = getProductionDeps();
      correlationId = gatewayDeps.uuidGen();
    }
    physicalAttempt += 1;
    const resp = await executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'listening.episode_generate_story',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
        actorType: 'system',
        executionLocation: 'system',
        correlationId,
        attemptNumber: physicalAttempt,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'listening-episode-generate-story',
          flowType: 'generate_story',
          maxAttemptsPerBlock: MAX_BLOCK_ATTEMPTS,
          physicalAttempt,
        },
        estimatedMetrics: estimateTextTokens(systemPrompt.length + userPrompt.length, MAX_OUTPUT_TOKENS),
      },
      () => client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
      }),
      gatewayDeps,
      extractEpisodeStoryMetrics,
    );
    const choice = resp.choices[0];
    const finishReason = choice?.finish_reason;
    const content = choice?.message?.content ?? '';
    if (finishReason === 'length') {
      throw new StoryOutputTruncatedError(AI_MODEL, content.length);
    }
    return content;
  };
}

// ── Block 1 generation ────────────────────────────────────────────────────────

async function generateBlock1(
  opts: GenerateStoryOptions,
  callAI: AICallFn,
): Promise<Block1Context & { wordCount: number }> {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  // block1Meta is preserved across expand/condense attempts so title/synopsis/outline survive
  let block1Meta: { title: string; synopsis: string; outline: string } | null = null;
  // adjustText is set when we have text but wrong word count; null means make a fresh block1 call
  let adjustText: { textEn: string; wordCount: number } | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_BLOCK_ATTEMPTS; attempt++) {
    let rawText: string;
    try {
      if (adjustText === null) {
        rawText = await callAI(BLOCK1_SYSTEM_PROMPT, buildBlock1UserPrompt(opts));
      } else if (adjustText.wordCount < range.min) {
        rawText = await callAI(EXPAND_BLOCK_SYSTEM_PROMPT, buildExpandBlockUserPrompt(opts, 1, adjustText.textEn, adjustText.wordCount));
      } else {
        rawText = await callAI(CONDENSE_BLOCK_SYSTEM_PROMPT, buildCondenseBlockUserPrompt(opts, 1, adjustText.textEn, adjustText.wordCount));
      }
    } catch (err) {
      if (err instanceof StoryOutputTruncatedError) {
        lastError = err;
        adjustText = null; // next attempt: fresh block1 call
        continue;
      }
      handleAIError(err);
    }

    let parsed: unknown;
    try { parsed = parseStoryJson(rawText!); }
    catch (err) { lastError = err as Error; adjustText = null; continue; }

    if (adjustText === null) {
      // First-time or retry: need full block1 structure
      let validated: ReturnType<typeof validateBlock1AIResponse>;
      try { validated = validateBlock1AIResponse(parsed); }
      catch (err) { lastError = err as Error; continue; }

      block1Meta = { title: validated.title, synopsis: validated.synopsis, outline: validated.outline };
      const { wordCount } = validated;

      if (wordCount >= range.min && wordCount <= range.max) {
        return { ...block1Meta, textEn: validated.textEn, wordCount };
      }
      adjustText = { textEn: validated.textEn, wordCount };
      lastError = wordCount < range.min
        ? new StoryBlock1TooShortError(wordCount, range.min)
        : new StoryBlockTooLongError(1, wordCount, range.max);
    } else {
      // Expand/condense response: only text_en
      let validated: { textEn: string; wordCount: number };
      try { validated = validateTextEnResponse(parsed); }
      catch (err) { lastError = err as Error; adjustText = null; continue; }

      const { wordCount } = validated;
      if (wordCount >= range.min && wordCount <= range.max) {
        return { ...block1Meta!, textEn: validated.textEn, wordCount };
      }
      adjustText = { textEn: validated.textEn, wordCount };
      lastError = wordCount < range.min
        ? new StoryBlock1TooShortError(wordCount, range.min)
        : new StoryBlockTooLongError(1, wordCount, range.max);
    }
  }

  throw lastError ?? new StoryBlock1TooShortError(0, range.min);
}

// ── Block 2 generation ────────────────────────────────────────────────────────

async function generateBlock2(
  opts: GenerateStoryOptions,
  context: Block1Context,
  callAI: AICallFn,
): Promise<{ textEn: string; wordCount: number }> {
  const range = WORD_COUNT_RANGES[opts.cefrLevel];
  let adjustText: { textEn: string; wordCount: number } | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_BLOCK_ATTEMPTS; attempt++) {
    let rawText: string;
    try {
      if (adjustText === null) {
        rawText = await callAI(BLOCK2_SYSTEM_PROMPT, buildBlock2UserPrompt(opts, context));
      } else if (adjustText.wordCount < range.min) {
        rawText = await callAI(EXPAND_BLOCK_SYSTEM_PROMPT, buildExpandBlockUserPrompt(opts, 2, adjustText.textEn, adjustText.wordCount));
      } else {
        rawText = await callAI(CONDENSE_BLOCK_SYSTEM_PROMPT, buildCondenseBlockUserPrompt(opts, 2, adjustText.textEn, adjustText.wordCount));
      }
    } catch (err) {
      if (err instanceof StoryOutputTruncatedError) {
        lastError = err;
        adjustText = null;
        continue;
      }
      handleAIError(err);
    }

    let parsed: unknown;
    try { parsed = parseStoryJson(rawText!); }
    catch (err) { lastError = err as Error; adjustText = null; continue; }

    let validated: { textEn: string; wordCount: number };
    try { validated = validateTextEnResponse(parsed); }
    catch (err) { lastError = err as Error; adjustText = null; continue; }

    const { wordCount } = validated;
    if (wordCount >= range.min && wordCount <= range.max) {
      return validated;
    }
    adjustText = { textEn: validated.textEn, wordCount };
    lastError = wordCount < range.min
      ? new StoryBlock2TooShortError(wordCount, range.min)
      : new StoryBlockTooLongError(2, wordCount, range.max);
  }

  throw lastError ?? new StoryBlock2TooShortError(0, range.min);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateListeningStory(
  opts: GenerateStoryOptions,
  callAI?: AICallFn,
  supabase?: SupabaseClient,
): Promise<GenerateStoryResult> {
  const idempotencyKey = buildIdempotencyKey(opts);
  const aiCallFn: AICallFn = callAI ?? createDefaultAICallFn(process.env.OPENAI_API_KEY ?? '');

  // Step 1: Generate and validate block 1 (title + synopsis + outline + text_en)
  const block1Result = await generateBlock1(opts, aiCallFn);

  // Step 2: Generate and validate block 2 (text_en, continuing from block 1)
  const block2Result = await generateBlock2(opts, block1Result, aiCallFn);

  // Step 3: Derive sentences deterministically
  let block1Sentences: ReturnType<typeof segmentListeningText>;
  let block2Sentences: ReturnType<typeof segmentListeningText>;
  try {
    block1Sentences = segmentListeningText(block1Result.textEn, 1);
    block2Sentences = segmentListeningText(block2Result.textEn, 2);
  } catch (err) {
    throw new StoryValidationError(
      err instanceof SentenceSegmentationError ? err.message : String(err)
    );
  }

  // Step 4: Assemble ValidatedStory
  const block1: ValidatedBlock = {
    blockOrder: 1,
    textEn: block1Result.textEn,
    wordCount: block1Result.wordCount,
    sentences: block1Sentences,
  };
  const block2: ValidatedBlock = {
    blockOrder: 2,
    textEn: block2Result.textEn,
    wordCount: block2Result.wordCount,
    sentences: block2Sentences,
  };
  const story: ValidatedStory = {
    title: block1Result.title,
    synopsis: block1Result.synopsis,
    cefrLevel: opts.cefrLevel,
    blocks: [block1, block2],
  };

  if (opts.dryRun) {
    return { story, episodeId: null, idempotencyKey };
  }

  if (!supabase) {
    throw new Error('Supabase client is required when dryRun is false');
  }

  const episodeId = await persistListeningStory(story, idempotencyKey, supabase, opts.theme);
  return { story, episodeId, idempotencyKey };
}
