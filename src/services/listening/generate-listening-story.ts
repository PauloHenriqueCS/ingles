import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../domain/curriculum/cefr';
import {
  STORY_SYSTEM_PROMPT, PROMPT_VERSION, CONTENT_VERSION,
  buildStoryUserPrompt, buildRetryUserPrompt, buildTruncatedRetryUserPrompt,
} from './build-listening-story-prompt';
import { parseStoryJson, validateListeningStoryResponse, StoryParseError, StoryValidationError } from './validate-listening-story';
import { persistListeningStory, StoryPersistError } from './persist-listening-story';
import type { ValidatedStory } from './listening-story-schema';

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

const AI_MODEL = 'gpt-4o';
const STORY_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
// Slim schema: ~2x450 words of English text + title + synopsis + JSON structure
// 450 words ≈ 600 tokens, x2 = 1200, overhead ~200 → 1600 tokens with margin
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

/** Injectable AI caller — receives raw text from the model */
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

export function createDefaultAICallFn(apiKey: string): AICallFn {
  const client = new OpenAI({ apiKey, timeout: STORY_TIMEOUT_MS, maxRetries: 0 });
  return async (systemPrompt: string, userPrompt: string) => {
    const resp = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = resp.choices[0];
    const finishReason = choice?.finish_reason;
    const content = choice?.message?.content ?? '';

    if (finishReason === 'length') {
      throw new StoryOutputTruncatedError(AI_MODEL, content.length);
    }

    return content;
  };
}

export async function generateListeningStory(
  opts: GenerateStoryOptions,
  callAI?: AICallFn,
  supabase?: SupabaseClient,
): Promise<GenerateStoryResult> {
  const idempotencyKey = buildIdempotencyKey(opts);
  const basePrompt = buildStoryUserPrompt(opts);

  const aiCallFn: AICallFn = callAI ?? createDefaultAICallFn(
    process.env.OPENAI_API_KEY ?? ''
  );

  let story: ValidatedStory | null = null;
  let lastError: StoryOutputTruncatedError | StoryParseError | StoryValidationError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let currentPrompt: string;
    if (attempt === 1 || lastError === null) {
      currentPrompt = basePrompt;
    } else if (lastError instanceof StoryOutputTruncatedError) {
      currentPrompt = buildTruncatedRetryUserPrompt(opts, attempt);
    } else {
      currentPrompt = buildRetryUserPrompt(opts, attempt, lastError.message);
    }

    let rawText: string;
    try {
      rawText = await aiCallFn(STORY_SYSTEM_PROMPT, currentPrompt);
    } catch (err) {
      if (err instanceof StoryOutputTruncatedError) {
        console.error(JSON.stringify({
          event: 'listening_story_truncated',
          model: err.model,
          finish_reason: 'length',
          responseChars: err.responseChars,
          attempt,
          cefrLevel: opts.cefrLevel,
          code: err.code,
        }));
        lastError = err;
        continue;
      }
      if (isTimeoutError(err)) throw new StoryAITimeoutError();
      if (isUnavailableError(err)) throw new StoryAIUnavailableError();
      throw new StoryAIUnavailableError(`AI call failed: ${String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = parseStoryJson(rawText);
    } catch (err) {
      lastError = err as StoryParseError;
      continue;
    }

    try {
      story = validateListeningStoryResponse(parsed, opts.cefrLevel);
      lastError = null;
      break;
    } catch (err) {
      if (err instanceof StoryValidationError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  if (!story) {
    if (lastError) throw lastError;
    throw new StoryParseError('Story generation failed after maximum attempts');
  }

  if (opts.dryRun) {
    return { story, episodeId: null, idempotencyKey };
  }

  if (!supabase) {
    throw new Error('Supabase client is required when dryRun is false');
  }

  const episodeId = await persistListeningStory(story, idempotencyKey, supabase, opts.theme);
  return { story, episodeId, idempotencyKey };
}
