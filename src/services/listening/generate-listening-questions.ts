import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../domain/curriculum/cefr';
import { executeAiGatewayCall, getProductionDeps } from '../../../api/_ai-gateway/index';
import type { GatewayUsageMetric } from '../../../api/_ai-gateway/index';
import {
  GENERATOR_SYSTEM_PROMPT,
  GENERATOR_PROMPT_VERSION,
  buildGeneratorUserPrompt,
  buildCorrectionUserPrompt,
} from './build-listening-question-prompt';
import type { BlockData } from './build-listening-question-prompt';
import {
  parseQuestionsJson,
  validateGeneratedQuestions,
  QuestionParseError,
  QuestionValidationError,
} from './validate-listening-questions';
import {
  validateAllQuestionsWithAI,
  VALIDATOR_PROMPT_VERSION,
} from './validate-questions-with-ai';
import type { AICallWithUsageFn, AICallResult } from './validate-questions-with-ai';
import { persistListeningQuestions } from './persist-listening-questions';
import type { ValidatedGeneratedQuestion, QuestionAIValidationResult } from './listening-question-schema';

export { QuestionParseError, QuestionValidationError };
export { GENERATOR_PROMPT_VERSION, VALIDATOR_PROMPT_VERSION };
export type { AICallWithUsageFn, AICallResult } from './validate-questions-with-ai';

// ─── Erros tipados ────────────────────────────────────────────────────────────

export class ListeningEpisodeNotFoundError extends Error {
  readonly code = 'LISTENING_EPISODE_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Listening episode not found: ${episodeId}`);
    this.name = 'ListeningEpisodeNotFoundError';
  }
}

export class ListeningEpisodeNotContentReadyError extends Error {
  readonly code = 'LISTENING_EPISODE_NOT_CONTENT_READY';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly status: string) {
    super(`Episode ${episodeId} is not content_ready (status: ${status})`);
    this.name = 'ListeningEpisodeNotContentReadyError';
  }
}

export class ListeningInvalidBlockStructureError extends Error {
  readonly code = 'LISTENING_INVALID_BLOCK_STRUCTURE';
  readonly retryable = false;
  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = 'ListeningInvalidBlockStructureError';
  }
}

export class ListeningMissingSentencesError extends Error {
  readonly code = 'LISTENING_MISSING_SENTENCES';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly blockOrder: number) {
    super(`No sentences found for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningMissingSentencesError';
  }
}

export class ListeningQuestionGenerationTimeoutError extends Error {
  readonly code = 'LISTENING_QUESTION_GENERATION_TIMEOUT';
  readonly retryable = true;
  constructor(readonly episodeId: string) {
    super(`AI call timed out generating questions for episode ${episodeId}`);
    this.name = 'ListeningQuestionGenerationTimeoutError';
  }
}

export class ListeningQuestionProviderError extends Error {
  readonly code = 'LISTENING_QUESTION_PROVIDER_ERROR';
  readonly retryable = true;
  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = 'ListeningQuestionProviderError';
  }
}

export class ListeningQuestionValidationFailedError extends Error {
  readonly code = 'LISTENING_QUESTION_VALIDATION_FAILED';
  readonly retryable = false;
  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = 'ListeningQuestionValidationFailedError';
  }
}

export class ListeningQuestionCorrectionFailedError extends Error {
  readonly code = 'LISTENING_QUESTION_CORRECTION_FAILED';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Question correction failed for episode ${episodeId}: questions remain invalid after one correction attempt`);
    this.name = 'ListeningQuestionCorrectionFailedError';
  }
}

export class ListeningQuestionsAlreadyExistError extends Error {
  readonly code = 'LISTENING_QUESTIONS_ALREADY_EXIST';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode ${episodeId} already has questions. Use forceRegeneration=true to replace them.`);
    this.name = 'ListeningQuestionsAlreadyExistError';
  }
}

export class ListeningPublishedEpisodeImmutableError extends Error {
  readonly code = 'LISTENING_PUBLISHED_EPISODE_IMMUTABLE';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode ${episodeId} is published and cannot be modified`);
    this.name = 'ListeningPublishedEpisodeImmutableError';
  }
}

// ─── Configuração ─────────────────────────────────────────────────────────────

const AI_MODEL = 'gpt-4o-mini';
const QUESTION_TIMEOUT_MS = 90_000;

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractQuestionMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
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

// ─── Factory do cliente de IA com rastreamento de tokens ──────────────────────

export function createQuestionAICallFn(apiKey: string): AICallWithUsageFn {
  const client = new OpenAI({ apiKey, timeout: QUESTION_TIMEOUT_MS, maxRetries: 0 });
  // Lazy: getProductionDeps() (and the Supabase client it constructs) must not
  // run just because this factory was created — only when a physical call is
  // actually about to happen. Callers build this closure via `callAI ??
  // createQuestionAICallFn(...)`, which evaluates eagerly even on paths that
  // never end up invoking it (dry-run, idempotent early-return).
  let gatewayDeps: ReturnType<typeof getProductionDeps> | undefined;
  let correlationId: string | undefined;
  let physicalAttempt = 0;

  return async (systemPrompt: string, userPrompt: string): Promise<AICallResult> => {
    if (!gatewayDeps) {
      gatewayDeps = getProductionDeps();
      correlationId = gatewayDeps.uuidGen();
    }
    const start = Date.now();
    physicalAttempt += 1;
    const resp = await executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'listening.episode_generate_questions',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
        actorType: 'system',
        executionLocation: 'system',
        correlationId,
        attemptNumber: physicalAttempt,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'listening-episode-generate-questions',
          flowType: 'generate_questions',
          physicalAttempt,
        },
      },
      () => client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      gatewayDeps,
      extractQuestionMetrics,
    );
    const durationMs = Date.now() - start;
    return {
      text: resp.choices[0]?.message?.content ?? '',
      usage: {
        promptTokens: resp.usage?.prompt_tokens ?? 0,
        completionTokens: resp.usage?.completion_tokens ?? 0,
        totalTokens: resp.usage?.total_tokens ?? 0,
        durationMs,
      },
      requestId: (resp as unknown as Record<string, unknown>)._request_id as string | null ?? null,
    };
  };
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

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

async function callGeneratorAI(
  callAI: AICallWithUsageFn,
  systemPrompt: string,
  userPrompt: string,
  episodeId: string,
): Promise<string> {
  let result: AICallResult;
  try {
    result = await callAI(systemPrompt, userPrompt);
  } catch (err) {
    if (isTimeoutError(err)) throw new ListeningQuestionGenerationTimeoutError(episodeId);
    if (isUnavailableError(err)) throw new ListeningQuestionProviderError(episodeId, 'AI service unavailable');
    throw new ListeningQuestionProviderError(episodeId, `AI call failed: ${String(err)}`);
  }

  console.error(JSON.stringify({
    event: 'listening_question_token_usage',
    stage: 'listening_question_generation',
    provider: 'openai',
    model: AI_MODEL,
    promptVersion: GENERATOR_PROMPT_VERSION,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    durationMs: result.usage.durationMs,
    requestId: result.requestId,
    episodeId,
    t: Date.now(),
  }));

  return result.text;
}

// ─── Tipos de entrada e saída ─────────────────────────────────────────────────

export interface GenerateListeningQuestionsInput {
  episodeId: string;
  forceRegeneration?: boolean;
  dryRun?: boolean;
  minConfidence?: number;
}

export interface GenerateListeningQuestionsResult {
  episodeId: string;
  questionCount: 2;
  validationStatus: 'valid';
  generatorPromptVersion: string;
  validatorPromptVersion: string;
  questions: Array<{
    questionOrder: 1 | 2;
    questionType: string;
    difficulty: string;
    validationConfidence: number;
  }>;
}

// ─── Funções de consulta ao banco ─────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  title: string;
  synopsis: string | null;
  cefr_level: string;
  status: string;
}

interface BlockRow {
  id: string;
  block_order: number;
  text_en: string;
}

interface SentenceRow {
  block_id: string;
  sentence_key: string;
  text_en: string;
  sentence_order: number;
}

interface QuestionRow {
  id: string;
  question_order: number;
  validation_status: string | null;
  generator_prompt_version: string | null;
}

async function loadEpisode(supabase: SupabaseClient, episodeId: string): Promise<EpisodeRow> {
  const { data, error } = await supabase
    .from('listening_episodes')
    .select('id, title, synopsis, cefr_level, status')
    .eq('id', episodeId)
    .single();

  if (error || !data) throw new ListeningEpisodeNotFoundError(episodeId);
  return data as EpisodeRow;
}

async function loadBlocks(supabase: SupabaseClient, episodeId: string): Promise<BlockRow[]> {
  const { data, error } = await supabase
    .from('listening_blocks')
    .select('id, block_order, text_en')
    .eq('episode_id', episodeId)
    .order('block_order');

  if (error) throw new ListeningInvalidBlockStructureError(episodeId, `Failed to load blocks: ${error.message}`);
  return (data ?? []) as BlockRow[];
}

async function loadSentences(supabase: SupabaseClient, blockIds: string[]): Promise<SentenceRow[]> {
  const { data, error } = await supabase
    .from('listening_sentences')
    .select('block_id, sentence_key, text_en, sentence_order')
    .in('block_id', blockIds)
    .order('sentence_order');

  if (error) throw new Error(`Failed to load sentences: ${error.message}`);
  return (data ?? []) as SentenceRow[];
}

async function loadExistingQuestions(supabase: SupabaseClient, episodeId: string): Promise<QuestionRow[]> {
  const { data, error } = await supabase
    .from('listening_questions')
    .select('id, question_order, validation_status, generator_prompt_version')
    .eq('episode_id', episodeId)
    .order('question_order');

  if (error) return [];
  return (data ?? []) as QuestionRow[];
}

// ─── Função principal ─────────────────────────────────────────────────────────

export async function generateListeningQuestions(
  input: GenerateListeningQuestionsInput,
  callAI?: AICallWithUsageFn,
  supabase?: SupabaseClient,
): Promise<GenerateListeningQuestionsResult> {
  const { episodeId, forceRegeneration = false, dryRun = false, minConfidence } = input;

  const aiCallFn: AICallWithUsageFn = callAI ?? createQuestionAICallFn(
    process.env.OPENAI_API_KEY ?? ''
  );

  const dbClient = supabase;

  let episode: EpisodeRow | null = null;
  let blocks: BlockRow[] = [];
  let sentences: SentenceRow[] = [];
  let sentenceKeysByBlock = new Map<number, Set<string>>();
  let blockDataMap = new Map<number, BlockData>();
  let blockIdByOrder = new Map<number, string>();

  if (dbClient && !dryRun) {
    // ── 1. Verificar estado do episódio ──────────────────────────────────────────
    episode = await loadEpisode(dbClient, episodeId);

    if (episode.status === 'published') {
      throw new ListeningPublishedEpisodeImmutableError(episodeId);
    }
    if (episode.status !== 'content_ready') {
      throw new ListeningEpisodeNotContentReadyError(episodeId, episode.status);
    }

    // ── 2. Verificar idempotência (antes de carregar blocos) ─────────────────
    const existingQuestions = await loadExistingQuestions(dbClient, episodeId);
    const validCurrentVersion = existingQuestions.filter(
      q => q.validation_status === 'valid' && q.generator_prompt_version === GENERATOR_PROMPT_VERSION
    );

    if (validCurrentVersion.length === 2) {
      // Resultado idempotente: retornar dados existentes sem consumir tokens
      return {
        episodeId,
        questionCount: 2,
        validationStatus: 'valid',
        generatorPromptVersion: GENERATOR_PROMPT_VERSION,
        validatorPromptVersion: VALIDATOR_PROMPT_VERSION,
        questions: [
          { questionOrder: 1, questionType: 'existing', difficulty: 'appropriate', validationConfidence: 1 },
          { questionOrder: 2, questionType: 'existing', difficulty: 'appropriate', validationConfidence: 1 },
        ],
      };
    }

    if (existingQuestions.length > 0 && !forceRegeneration) {
      throw new ListeningQuestionsAlreadyExistError(episodeId);
    }

    // ── 3. Marcar como em processamento ──
    await dbClient
      .from('listening_episodes')
      .update({ questions_status: 'processing' })
      .eq('id', episodeId);

    // ── 4. Carregar blocos e frases ──────────────────────────────────────────────
    blocks = await loadBlocks(dbClient, episodeId);
    if (blocks.length !== 2) {
      throw new ListeningInvalidBlockStructureError(episodeId,
        `Episode must have exactly 2 blocks, found ${blocks.length}`);
    }
    const blockOrders = blocks.map(b => b.block_order).sort((a, b) => a - b);
    if (blockOrders[0] !== 1 || blockOrders[1] !== 2) {
      throw new ListeningInvalidBlockStructureError(episodeId,
        `Block orders must be [1, 2], got [${blockOrders.join(', ')}]`);
    }
    for (const b of blocks) {
      blockIdByOrder.set(b.block_order, b.id);
    }

    sentences = await loadSentences(dbClient, blocks.map(b => b.id));
    for (const b of blocks) {
      const blockSentences = sentences.filter(s => s.block_id === b.id);
      if (blockSentences.length === 0) {
        throw new ListeningMissingSentencesError(episodeId, b.block_order);
      }
      sentenceKeysByBlock.set(b.block_order, new Set(blockSentences.map(s => s.sentence_key)));
      blockDataMap.set(b.block_order, {
        blockOrder: b.block_order as 1 | 2,
        textEn: b.text_en,
        sentences: blockSentences
          .sort((a, c) => a.sentence_order - c.sentence_order)
          .map(s => ({ sentenceKey: s.sentence_key, textEn: s.text_en })),
      });
    }
  }

  // ── 4. Preparar dados para geração ───────────────────────────────────────────
  // Em dry-run sem banco, usa estrutura vazia para testes de mock de AI
  const blocksForPrompt: [BlockData, BlockData] = [
    blockDataMap.get(1) ?? { blockOrder: 1, textEn: '', sentences: [] },
    blockDataMap.get(2) ?? { blockOrder: 2, textEn: '', sentences: [] },
  ];

  const generatorPromptInput = {
    episodeId,
    title: episode?.title ?? '',
    synopsis: episode?.synopsis ?? null,
    cefrLevel: (episode?.cefr_level ?? 'B1') as CEFRLevel,
    blocks: blocksForPrompt,
  };

  // ── 5. Gerar perguntas com IA ─────────────────────────────────────────────────
  const userPrompt = buildGeneratorUserPrompt(generatorPromptInput);
  const rawText = await callGeneratorAI(aiCallFn, GENERATOR_SYSTEM_PROMPT, userPrompt, episodeId);

  // ── 6. Parse e validação determinística ───────────────────────────────────────
  let parsedRaw: unknown;
  try {
    parsedRaw = parseQuestionsJson(rawText);
  } catch (err) {
    if (err instanceof QuestionParseError) {
      if (dbClient && !dryRun) {
        await dbClient.from('listening_episodes')
          .update({ questions_status: 'failed' })
          .eq('id', episodeId);
      }
      throw err;
    }
    throw err;
  }

  // Pass sentenceKeysByBlock only when populated from DB (undefined in dry-run without DB)
  const keyMap = sentenceKeysByBlock.size > 0 ? sentenceKeysByBlock : undefined;

  let questions: [ValidatedGeneratedQuestion, ValidatedGeneratedQuestion];
  try {
    questions = validateGeneratedQuestions(parsedRaw, keyMap);
  } catch (err) {
    if (dbClient && !dryRun) {
      await dbClient.from('listening_episodes')
        .update({ questions_status: 'failed' })
        .eq('id', episodeId);
    }
    throw err;
  }

  // ── 7. Validação por IA (uma chamada por pergunta) ─────────────────────────────
  let validationResults: [QuestionAIValidationResult, QuestionAIValidationResult];
  validationResults = await validateAllQuestionsWithAI(
    questions,
    blocksForPrompt,
    generatorPromptInput.cefrLevel,
    aiCallFn,
    episodeId,
    { minConfidence },
  );

  const allValid = validationResults.every(r => r.valid);

  // ── 8. Correção (se necessário, máximo 1 tentativa) ─────────────────────────
  if (!allValid) {
    const correctionPrompt = buildCorrectionUserPrompt({
      questions: [questions[0], questions[1]],
      validationResults: [validationResults[0], validationResults[1]],
      blocks: blocksForPrompt,
      cefrLevel: generatorPromptInput.cefrLevel,
    });

    let correctedText: string;
    try {
      const { text, usage, requestId } = await aiCallFn(GENERATOR_SYSTEM_PROMPT, correctionPrompt);
      correctedText = text;

      console.error(JSON.stringify({
        event: 'listening_question_token_usage',
        stage: 'listening_question_correction',
        provider: 'openai',
        model: AI_MODEL,
        promptVersion: GENERATOR_PROMPT_VERSION,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        durationMs: usage.durationMs,
        requestId,
        episodeId,
        t: Date.now(),
      }));
    } catch (err) {
      if (isTimeoutError(err)) throw new ListeningQuestionGenerationTimeoutError(episodeId);
      throw new ListeningQuestionProviderError(episodeId, `Correction AI call failed: ${String(err)}`);
    }

    // Re-validar deterministicamente
    let correctedParsed: unknown;
    try {
      correctedParsed = parseQuestionsJson(correctedText);
      questions = validateGeneratedQuestions(correctedParsed, keyMap);
    } catch {
      if (dbClient && !dryRun) {
        await dbClient.from('listening_episodes')
          .update({ questions_status: 'failed' })
          .eq('id', episodeId);
      }
      throw new ListeningQuestionCorrectionFailedError(episodeId);
    }

    // Re-validar com IA
    validationResults = await validateAllQuestionsWithAI(
      questions,
      blocksForPrompt,
      generatorPromptInput.cefrLevel,
      aiCallFn,
      episodeId,
      { minConfidence },
    );

    const allValidAfterCorrection = validationResults.every(r => r.valid);
    if (!allValidAfterCorrection) {
      if (dbClient && !dryRun) {
        await dbClient.from('listening_episodes')
          .update({ questions_status: 'failed' })
          .eq('id', episodeId);
      }
      throw new ListeningQuestionCorrectionFailedError(episodeId);
    }
  }

  // ── 9. Persistir (se não for dry-run) ─────────────────────────────────────────
  if (!dryRun && dbClient) {
    await persistListeningQuestions({
      supabase: dbClient,
      episodeId,
      blockIdByOrder,
      questions,
      validationResults,
      cefrLevel: generatorPromptInput.cefrLevel,
    });
  }

  return {
    episodeId,
    questionCount: 2,
    validationStatus: 'valid',
    generatorPromptVersion: GENERATOR_PROMPT_VERSION,
    validatorPromptVersion: VALIDATOR_PROMPT_VERSION,
    questions: questions.map((q, i) => ({
      questionOrder: q.questionOrder,
      questionType: q.questionType,
      difficulty: q.difficulty,
      validationConfidence: validationResults[i].confidence,
    })),
  };
}
