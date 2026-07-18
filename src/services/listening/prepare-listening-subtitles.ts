import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type { AICallWithUsageFn, AICallResult } from './validate-questions-with-ai';
import { executeAiGatewayCall, getProductionDeps } from '../../../api/_ai-gateway/index';
import type { GatewayUsageMetric } from '../../../api/_ai-gateway/index';
import { buildEnglishSubtitleCues } from './build-english-subtitle-cues';
import type { CanonicalSentence } from './build-english-subtitle-cues';
import { validateEnglishReconstruction } from './reconstruct-subtitle-text';
import {
  translateSubtitles,
  validateTranslationDeterministic,
  validateBlockTranslationWithAI,
  correctBlockTranslation,
  SubtitleTranslationParseError,
  SubtitleTranslationValidationError,
  TRANSLATION_PROMPT_VERSION,
  VALIDATOR_PROMPT_VERSION,
} from './translate-listening-subtitles';
import { persistListeningSubtitles } from './persist-listening-subtitles';
import type { EnglishCueDraft, ValidatedTranslatedCue } from './listening-subtitle-schema';
import type { BlockCueData } from './build-subtitle-translation-prompt';

export { SubtitleTranslationParseError, SubtitleTranslationValidationError };
export { TRANSLATION_PROMPT_VERSION, VALIDATOR_PROMPT_VERSION };
export type { AICallWithUsageFn, AICallResult };

// ─── Typed errors ─────────────────────────────────────────────────────────────

export class ListeningEpisodeNotFoundError extends Error {
  readonly code = 'LISTENING_EPISODE_NOT_FOUND';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode not found: ${episodeId}`);
    this.name = 'ListeningEpisodeNotFoundError';
  }
}

export class ListeningEpisodeNotReadyForSubtitlesError extends Error {
  readonly code = 'LISTENING_EPISODE_NOT_READY_FOR_SUBTITLES';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly status: string) {
    super(`Episode ${episodeId} is not content_ready (status: ${status})`);
    this.name = 'ListeningEpisodeNotReadyForSubtitlesError';
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

export class ListeningMissingBlocksError extends Error {
  readonly code = 'LISTENING_MISSING_BLOCKS';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly found: number) {
    super(`Episode ${episodeId} must have 2 blocks, found ${found}`);
    this.name = 'ListeningMissingBlocksError';
  }
}

export class ListeningMissingSentencesError extends Error {
  readonly code = 'LISTENING_MISSING_SENTENCES';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly blockOrder: number) {
    super(`No sentences for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningMissingSentencesError';
  }
}

export class ListeningEnglishReconstructionFailedError extends Error {
  readonly code = 'LISTENING_ENGLISH_RECONSTRUCTION_FAILED';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly blockOrder: number, detail: string) {
    super(`English reconstruction failed for episode ${episodeId} block ${blockOrder}: ${detail}`);
    this.name = 'ListeningEnglishReconstructionFailedError';
  }
}

export class ListeningTranslationTimeoutError extends Error {
  readonly code = 'LISTENING_TRANSLATION_TIMEOUT';
  readonly retryable = true;
  constructor(readonly episodeId: string) {
    super(`AI translation timed out for episode ${episodeId}`);
    this.name = 'ListeningTranslationTimeoutError';
  }
}

export class ListeningTranslationProviderError extends Error {
  readonly code = 'LISTENING_TRANSLATION_PROVIDER_ERROR';
  readonly retryable = true;
  constructor(readonly episodeId: string, message: string) {
    super(message);
    this.name = 'ListeningTranslationProviderError';
  }
}

export class ListeningTranslationValidationFailedError extends Error {
  readonly code = 'LISTENING_TRANSLATION_VALIDATION_FAILED';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly blockOrder: number, issues: string[]) {
    super(`Translation validation failed for episode ${episodeId} block ${blockOrder}: ${issues.join('; ')}`);
    this.name = 'ListeningTranslationValidationFailedError';
  }
}

export class ListeningTranslationCorrectionFailedError extends Error {
  readonly code = 'LISTENING_TRANSLATION_CORRECTION_FAILED';
  readonly retryable = false;
  constructor(readonly episodeId: string, readonly blockOrder: number) {
    super(`Translation correction still invalid for episode ${episodeId} block ${blockOrder}`);
    this.name = 'ListeningTranslationCorrectionFailedError';
  }
}

export class ListeningSubtitlesAlreadyExistError extends Error {
  readonly code = 'LISTENING_SUBTITLES_ALREADY_EXIST';
  readonly retryable = false;
  constructor(readonly episodeId: string) {
    super(`Episode ${episodeId} already has subtitles. Use forceRegeneration=true to replace.`);
    this.name = 'ListeningSubtitlesAlreadyExistError';
  }
}

// ─── AI client factory ────────────────────────────────────────────────────────

const AI_MODEL = 'gpt-4o-mini';
const SUBTITLE_TIMEOUT_MS = 120_000;

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractSubtitleMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
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

export function createSubtitleAICallFn(apiKey: string): AICallWithUsageFn {
  const client = new OpenAI({ apiKey, timeout: SUBTITLE_TIMEOUT_MS, maxRetries: 0 });
  // Lazy: getProductionDeps() (and the Supabase client it constructs) must not
  // run just because this factory was created — only when a physical call is
  // actually about to happen. Callers build this closure via `callAI ??
  // createSubtitleAICallFn(...)`, which evaluates eagerly even on paths that
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
        featureKey: 'listening.episode_translate_subtitles',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
        actorType: 'system',
        executionLocation: 'system',
        correlationId,
        attemptNumber: physicalAttempt,
        callSequence: 1,
        technicalMetadata: {
          endpoint: 'listening-episode-translate-subtitles',
          flowType: 'prepare_subtitles',
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
      extractSubtitleMetrics,
    );
    return {
      text: resp.choices[0]?.message?.content ?? '',
      usage: {
        promptTokens: resp.usage?.prompt_tokens ?? 0,
        completionTokens: resp.usage?.completion_tokens ?? 0,
        totalTokens: resp.usage?.total_tokens ?? 0,
        durationMs: Date.now() - start,
      },
      requestId: (resp as unknown as Record<string, unknown>)._request_id as string | null ?? null,
    };
  };
}

// ─── Input/Output types ───────────────────────────────────────────────────────

export interface PrepareListeningSubtitlesInput {
  episodeId: string;
  forceRegeneration?: boolean;
  dryRun?: boolean;
  minConfidence?: number;
}

export interface PrepareListeningSubtitlesResult {
  episodeId: string;
  blockCount: 2;
  englishCueCount: number;
  portugueseCueCount: number;
  status: 'ready';
  translationPromptVersion: string;
  validatorPromptVersion: string;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  title: string;
  synopsis: string | null;
  cefr_level: string;
  status: string;
  content_version: number;
  subtitles_status: string | null;
  subtitle_prompt_version: string | null;
}

interface BlockRow {
  id: string;
  block_order: number;
  text_en: string;
}

interface SentenceRow {
  block_id: string;
  sentence_key: string;
  sentence_order: number;
  speaker: string | null;
  text_en: string;
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; constructor?: { name?: string } };
  return e.name === 'AbortError' || e.message === 'timeout' ||
    (e.constructor?.name ?? '').includes('Timeout');
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function prepareListeningSubtitles(
  input: PrepareListeningSubtitlesInput,
  callAI?: AICallWithUsageFn,
  supabase?: SupabaseClient,
): Promise<PrepareListeningSubtitlesResult> {
  const { episodeId, forceRegeneration = false, dryRun = false, minConfidence = 0.90 } = input;

  const aiCallFn: AICallWithUsageFn = callAI ?? createSubtitleAICallFn(process.env.OPENAI_API_KEY ?? '');

  let episode: EpisodeRow | null = null;
  let blockIdByOrder = new Map<number, string>();
  let englishCuesByBlock = new Map<1 | 2, EnglishCueDraft[]>();
  let blockTextEnByOrder = new Map<1 | 2, string>();
  let contentVersion = 1;

  // ── DB operations (only in non-dry-run mode) ─────────────────────────────────
  if (supabase && !dryRun) {
    // 1. Load episode
    const { data: epData, error: epErr } = await supabase
      .from('listening_episodes')
      .select('id, title, synopsis, cefr_level, status, content_version, subtitles_status, subtitle_prompt_version')
      .eq('id', episodeId)
      .single();

    if (epErr || !epData) throw new ListeningEpisodeNotFoundError(episodeId);
    episode = epData as EpisodeRow;
    contentVersion = episode.content_version;

    if (episode.status === 'published') throw new ListeningPublishedEpisodeImmutableError(episodeId);
    if (episode.status !== 'content_ready') {
      throw new ListeningEpisodeNotReadyForSubtitlesError(episodeId, episode.status);
    }

    // 2. Idempotency check
    if (episode.subtitles_status === 'ready' && episode.subtitle_prompt_version === TRANSLATION_PROMPT_VERSION) {
      const { data: existingCues } = await supabase
        .from('listening_subtitle_cues')
        .select('language, cue_order')
        .in('block_id', (await supabase.from('listening_blocks').select('id').eq('episode_id', episodeId).order('block_order')).data?.map((b: { id: string }) => b.id) ?? [])
        .order('cue_order');

      const enCount = (existingCues ?? []).filter((c: { language: string }) => c.language === 'en').length;
      const ptCount = (existingCues ?? []).filter((c: { language: string }) => c.language === 'pt-BR').length;
      if (enCount > 0 && enCount === ptCount) {
        return {
          episodeId, blockCount: 2, englishCueCount: enCount, portugueseCueCount: ptCount,
          status: 'ready', translationPromptVersion: TRANSLATION_PROMPT_VERSION,
          validatorPromptVersion: VALIDATOR_PROMPT_VERSION,
        };
      }
    }

    if (episode.subtitles_status !== null && episode.subtitles_status !== 'failed' && !forceRegeneration) {
      throw new ListeningSubtitlesAlreadyExistError(episodeId);
    }

    // 3. Mark as processing
    await supabase.from('listening_episodes')
      .update({ subtitles_status: 'processing' })
      .eq('id', episodeId);

    // 4. Load blocks
    const { data: blocksData, error: blocksErr } = await supabase
      .from('listening_blocks')
      .select('id, block_order, text_en')
      .eq('episode_id', episodeId)
      .order('block_order');

    if (blocksErr || !blocksData || blocksData.length !== 2) {
      throw new ListeningMissingBlocksError(episodeId, blocksData?.length ?? 0);
    }
    const blocks = blocksData as BlockRow[];
    for (const b of blocks) blockIdByOrder.set(b.block_order, b.id);

    // 5. Load sentences
    const blockIds = blocks.map(b => b.id);
    const { data: sentData, error: sentErr } = await supabase
      .from('listening_sentences')
      .select('block_id, sentence_key, sentence_order, speaker, text_en')
      .in('block_id', blockIds)
      .order('sentence_order');

    if (sentErr) throw new Error(`Failed to load sentences: ${sentErr.message}`);
    const sentences = (sentData ?? []) as SentenceRow[];

    // 6. Build English cues per block
    const cefrLevel = episode.cefr_level as CEFRLevel;
    for (const b of blocks) {
      const blockOrder = b.block_order as 1 | 2;
      const blockSentences: CanonicalSentence[] = sentences
        .filter(s => s.block_id === b.id)
        .sort((a, c) => a.sentence_order - c.sentence_order)
        .map(s => ({ sentenceKey: s.sentence_key, sentenceOrder: s.sentence_order, speaker: s.speaker, textEn: s.text_en }));

      if (blockSentences.length === 0) throw new ListeningMissingSentencesError(episodeId, blockOrder);

      try {
        const enCues = buildEnglishSubtitleCues(blockSentences, blockOrder, cefrLevel);
        validateEnglishReconstruction(b.text_en, enCues);
        englishCuesByBlock.set(blockOrder, enCues);
        blockTextEnByOrder.set(blockOrder, b.text_en);
      } catch (err) {
        throw new ListeningEnglishReconstructionFailedError(episodeId, blockOrder, String(err));
      }
    }
  }

  // ── For dry-run or missing DB, use episode info passed or defaults ───────────
  if (dryRun && !supabase) {
    // Pure dry-run: nothing to do — AI won't be called without actual data
    return {
      episodeId, blockCount: 2, englishCueCount: 0, portugueseCueCount: 0,
      status: 'ready', translationPromptVersion: TRANSLATION_PROMPT_VERSION,
      validatorPromptVersion: VALIDATOR_PROMPT_VERSION,
    };
  }

  if (englishCuesByBlock.size === 0) {
    // dry-run WITH supabase: load blocks/sentences but don't persist
    // This path is hit when dryRun=true and supabase provided — load data only
    if (supabase && dryRun) {
      const { data: epData } = await supabase
        .from('listening_episodes')
        .select('id, title, synopsis, cefr_level, status, content_version, subtitles_status, subtitle_prompt_version')
        .eq('id', episodeId)
        .single();
      if (!epData) throw new ListeningEpisodeNotFoundError(episodeId);
      episode = epData as EpisodeRow;
      if (episode.status === 'published') throw new ListeningPublishedEpisodeImmutableError(episodeId);

      const { data: blocksData } = await supabase
        .from('listening_blocks').select('id, block_order, text_en')
        .eq('episode_id', episodeId).order('block_order');
      const blocks = (blocksData ?? []) as BlockRow[];
      if (blocks.length !== 2) throw new ListeningMissingBlocksError(episodeId, blocks.length);
      for (const b of blocks) blockIdByOrder.set(b.block_order, b.id);
      contentVersion = episode.content_version;

      const blockIds = blocks.map(b => b.id);
      const { data: sentData } = await supabase
        .from('listening_sentences').select('block_id, sentence_key, sentence_order, speaker, text_en')
        .in('block_id', blockIds).order('sentence_order');
      const sentences = (sentData ?? []) as SentenceRow[];

      const cefrLevel = episode.cefr_level as CEFRLevel;
      for (const b of blocks) {
        const blockOrder = b.block_order as 1 | 2;
        const blockSentences: CanonicalSentence[] = sentences
          .filter(s => s.block_id === b.id)
          .sort((a, c) => a.sentence_order - c.sentence_order)
          .map(s => ({ sentenceKey: s.sentence_key, sentenceOrder: s.sentence_order, speaker: s.speaker, textEn: s.text_en }));
        if (blockSentences.length === 0) throw new ListeningMissingSentencesError(episodeId, blockOrder);
        try {
          const enCues = buildEnglishSubtitleCues(blockSentences, blockOrder, cefrLevel);
          validateEnglishReconstruction(b.text_en, enCues);
          englishCuesByBlock.set(blockOrder, enCues);
          blockTextEnByOrder.set(blockOrder, b.text_en);
        } catch (err) {
          throw new ListeningEnglishReconstructionFailedError(episodeId, blockOrder, String(err));
        }
      }
    }
  }

  if (englishCuesByBlock.size === 0) {
    // No data available — can't continue
    throw new ListeningMissingBlocksError(episodeId, 0);
  }

  const cefrLevel = (episode?.cefr_level ?? 'B1') as CEFRLevel;

  // ── 7. Translate all blocks in one AI call ────────────────────────────────────
  const blocksForTranslation = [
    {
      blockOrder: 1 as const,
      blockTextEn: blockTextEnByOrder.get(1) ?? '',
      cues: englishCuesByBlock.get(1) ?? [],
    },
    {
      blockOrder: 2 as const,
      blockTextEn: blockTextEnByOrder.get(2) ?? '',
      cues: englishCuesByBlock.get(2) ?? [],
    },
  ] as [BlockCueData, BlockCueData];

  let rawTranslation: Awaited<ReturnType<typeof translateSubtitles>>;
  try {
    rawTranslation = await translateSubtitles(
      blocksForTranslation,
      episodeId,
      episode?.title ?? '',
      episode?.synopsis ?? null,
      cefrLevel,
      aiCallFn,
    );
  } catch (err) {
    if (isTimeoutError(err)) throw new ListeningTranslationTimeoutError(episodeId);
    if (!(err instanceof SubtitleTranslationParseError)) {
      throw new ListeningTranslationProviderError(episodeId, `Translation AI call failed: ${String(err)}`);
    }
    throw err;
  }

  // ── 8. Deterministic validation ───────────────────────────────────────────────
  let translatedCues: Map<1 | 2, ValidatedTranslatedCue[]>;
  try {
    translatedCues = validateTranslationDeterministic(rawTranslation, englishCuesByBlock);
  } catch (err) {
    if (supabase && !dryRun) {
      await supabase.from('listening_episodes').update({ subtitles_status: 'failed' }).eq('id', episodeId);
    }
    throw err;
  }

  // ── 9. AI semantic validation per block (with optional correction) ────────────
  for (const blockOrder of [1, 2] as const) {
    const blockCues = translatedCues.get(blockOrder)!;
    const blockTextEn = blockTextEnByOrder.get(blockOrder) ?? '';

    let validation = await validateBlockTranslationWithAI(
      blockOrder, blockTextEn, blockCues, cefrLevel, episodeId, aiCallFn, minConfidence
    );

    if (!validation.valid) {
      // One correction attempt
      const correctedCues = await correctBlockTranslation(
        blockOrder, blockTextEn, blockCues, validation, cefrLevel, episodeId, aiCallFn
      );

      // Re-validate after correction
      validation = await validateBlockTranslationWithAI(
        blockOrder, blockTextEn, correctedCues, cefrLevel, episodeId, aiCallFn, minConfidence
      );

      if (!validation.valid) {
        if (supabase && !dryRun) {
          await supabase.from('listening_episodes').update({ subtitles_status: 'failed' }).eq('id', episodeId);
        }
        throw new ListeningTranslationCorrectionFailedError(episodeId, blockOrder);
      }

      translatedCues.set(blockOrder, correctedCues);
    }
  }

  // ── 10. Reconstruct translation_pt from pt-BR cues ────────────────────────────
  const blockTranslationPt = new Map<1 | 2, string>();
  for (const blockOrder of [1, 2] as const) {
    const ptCues = translatedCues.get(blockOrder)!;
    blockTranslationPt.set(blockOrder, ptCues.map(c => c.textPtBr).join(' '));
  }

  const totalEnCues = (englishCuesByBlock.get(1)?.length ?? 0) + (englishCuesByBlock.get(2)?.length ?? 0);
  const totalPtCues = (translatedCues.get(1)?.length ?? 0) + (translatedCues.get(2)?.length ?? 0);

  // ── 11. Persist (not in dry-run) ──────────────────────────────────────────────
  if (!dryRun && supabase) {
    await persistListeningSubtitles({
      supabase, episodeId, contentVersion,
      blockIdByOrder, englishCues: englishCuesByBlock,
      translatedCues, blockTranslationPt,
    });
  }

  return {
    episodeId,
    blockCount: 2,
    englishCueCount: totalEnCues,
    portugueseCueCount: totalPtCues,
    status: 'ready',
    translationPromptVersion: TRANSLATION_PROMPT_VERSION,
    validatorPromptVersion: VALIDATOR_PROMPT_VERSION,
  };
}
