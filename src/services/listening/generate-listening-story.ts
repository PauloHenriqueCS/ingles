import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../domain/curriculum/cefr';
import { STORY_SYSTEM_PROMPT, PROMPT_VERSION, CONTENT_VERSION, buildStoryUserPrompt } from './build-listening-story-prompt';
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

const AI_MODEL = 'gpt-4o-mini';
const STORY_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;

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
    });
    return resp.choices[0]?.message?.content ?? '';
  };
}

export async function generateListeningStory(
  opts: GenerateStoryOptions,
  callAI?: AICallFn,
  supabase?: SupabaseClient,
): Promise<GenerateStoryResult> {
  const idempotencyKey = buildIdempotencyKey(opts);
  const userPrompt = buildStoryUserPrompt(opts);

  const aiCallFn: AICallFn = callAI ?? createDefaultAICallFn(
    process.env.OPENAI_API_KEY ?? ''
  );

  let story: ValidatedStory | null = null;
  let lastParseError: StoryParseError | null = null;
  let lastValidationError: StoryValidationError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let rawText: string;
    try {
      rawText = await aiCallFn(STORY_SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      if (isTimeoutError(err)) throw new StoryAITimeoutError();
      if (isUnavailableError(err)) throw new StoryAIUnavailableError();
      throw new StoryAIUnavailableError(`AI call failed: ${String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = parseStoryJson(rawText);
    } catch (err) {
      lastParseError = err as StoryParseError;
      continue;
    }

    try {
      story = validateListeningStoryResponse(parsed, opts.cefrLevel);
      lastParseError = null;
      lastValidationError = null;
      break;
    } catch (err) {
      if (err instanceof StoryValidationError) {
        lastValidationError = err;
        continue;
      }
      throw err;
    }
  }

  if (!story) {
    if (lastParseError) throw lastParseError;
    if (lastValidationError) throw lastValidationError;
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
