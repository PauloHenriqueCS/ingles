import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import type { SupabaseClient } from '@supabase/supabase-js';
import { executeAiGatewayCall, getProductionDeps, estimateTextTokens } from '../../../api/_ai-gateway/index';
import type { GatewayUsageMetric } from '../../../api/_ai-gateway/index';

export const SYNOPSIS_TRANSLATION_SYSTEM_PROMPT = 'You are a professional translator. Translate the English text to natural Brazilian Portuguese. Preserve the tone and brevity. Return ONLY the translated text, nothing else.';

const SYNOPSIS_MODEL = 'gpt-4o-mini';
const SYNOPSIS_MAX_TOKENS = 200;

export type TranslateListeningSynopsisInput = {
  episodeId: string;
  /** technicalMetadata.endpoint recorded on the AI Gateway event — identifies the calling pipeline. */
  endpoint: string;
};

export type TranslateListeningSynopsisResult = {
  /** false when skipped: no synopsis yet, or synopsis_pt already present (idempotent no-op). */
  translated: boolean;
  synopsisPt: string | null;
};

function extractSynopsisMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
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

/**
 * Translates a listening episode's English synopsis to Brazilian Portuguese
 * via the AI Gateway, idempotently (skips the call entirely if synopsis_pt is
 * already set). Shared by both the per-user on-demand pipeline and the
 * shared level-group pipeline — both use the same listening_episodes row and
 * the same idempotency semantics, so there is nothing pipeline-specific here.
 */
export async function translateListeningSynopsis(
  input: TranslateListeningSynopsisInput,
  supabase: SupabaseClient,
): Promise<TranslateListeningSynopsisResult> {
  const { episodeId, endpoint } = input;

  const { data: episode } = await supabase
    .from('listening_episodes')
    .select('synopsis, synopsis_pt')
    .eq('id', episodeId)
    .maybeSingle();

  if (!episode || episode.synopsis_pt || !episode.synopsis) {
    return { translated: false, synopsisPt: episode?.synopsis_pt ?? null };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('Missing environment variable: OPENAI_API_KEY');
  const client = new OpenAI({ apiKey: openaiKey, timeout: 30_000, maxRetries: 1 });

  const gatewayDeps = getProductionDeps();
  const response = await executeAiGatewayCall<ChatCompletion>(
    {
      featureKey: 'listening.episode_translate_synopsis',
      provider: 'openai',
      service: 'chat.completions',
      model: SYNOPSIS_MODEL,
      actorType: 'system',
      executionLocation: 'system',
      correlationId: gatewayDeps.uuidGen(),
      attemptNumber: 1,
      callSequence: 1,
      resourceType: 'listening_episode',
      resourceId: episodeId,
      technicalMetadata: {
        endpoint,
        flowType: 'preparing_description',
      },
      estimatedMetrics: estimateTextTokens(SYNOPSIS_TRANSLATION_SYSTEM_PROMPT.length + episode.synopsis.length, SYNOPSIS_MAX_TOKENS),
    },
    () => client.chat.completions.create({
      model: SYNOPSIS_MODEL,
      messages: [
        { role: 'system', content: SYNOPSIS_TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: episode.synopsis },
      ],
      max_tokens: SYNOPSIS_MAX_TOKENS,
      temperature: 0.3,
    }),
    gatewayDeps,
    extractSynopsisMetrics,
  );

  const synopsisPt = response.choices[0]?.message?.content?.trim() ?? '';
  if (synopsisPt) {
    await supabase
      .from('listening_episodes')
      .update({ synopsis_pt: synopsisPt, updated_at: new Date().toISOString() })
      .eq('id', episodeId);
  }

  return { translated: synopsisPt.length > 0, synopsisPt: synopsisPt || null };
}
