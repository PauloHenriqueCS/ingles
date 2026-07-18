/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Pre-call metric estimates (Etapa 11, Fase 6) — used only to size a
 * reservation before calling a provider. Every function here is pure, runs
 * entirely in memory, and returns numbers only: no request/response content
 * is ever persisted by this module. Cached tokens are never presumed before
 * a response — every estimator here treats the cached share as zero.
 *
 * Not every feature has a safe estimator yet (Fase 6: "se não houver
 * estimativa segura, manter feature em observe, reportar
 * enforcement_not_ready, não fingir proteção forte") — callers check
 * `hasEstimator` in feature-catalog-adjacent readiness data (see
 * preflight, scripts/ai-gateway-enforce-preflight.ts) rather than assuming
 * one of these always applies.
 */

import { countTtsPlainTextCharacters, countTtsSsmlCharacters } from './tts-character-count';

export interface MetricEstimate {
  metricKey: string;
  quantity: number;
}

/** TTS: the real character count of the exact text/SSML about to be sent — never a guess. */
export function estimateTtsCharacters(input: string, isSsml: boolean): MetricEstimate {
  const quantity = isSsml ? countTtsSsmlCharacters(input) : countTtsPlainTextCharacters(input);
  return { metricKey: 'tts_characters', quantity };
}

/**
 * Recorded audio (e.g. pronunciation assessment): the plan/session's
 * authorized ceiling in seconds — never the client's claimed recording
 * length, which isn't known server-side before the call anyway.
 */
export function estimateAudioSecondsCeiling(maxAuthorizedSeconds: number): MetricEstimate {
  return { metricKey: 'audio_seconds', quantity: Math.max(0, maxAuthorizedSeconds) };
}

/**
 * Realtime session: the server-authorized maximum session length (the same
 * deadline value returned to the client — see the realtime session-control
 * endpoint) is the only safe upper bound before the session has actually
 * run; real duration is only known at session-end (session_seconds is
 * measured then, not estimated).
 */
export function estimateRealtimeSessionSeconds(maxAuthorizedSeconds: number): MetricEstimate {
  return { metricKey: 'session_seconds', quantity: Math.max(0, maxAuthorizedSeconds) };
}

/**
 * Text tokens: a conservative, in-memory-only heuristic (~4 characters per
 * token for English, per OpenAI's own published rule of thumb) over the
 * input string length plus the feature's own configured max output tokens
 * — never the actual tokenizer (would require persisting/re-deriving the
 * prompt), and never trusted as exact — only as a reservation ceiling.
 */
export function estimateTextTokens(inputCharacterCount: number, maxOutputTokens: number): MetricEstimate[] {
  const CHARS_PER_TOKEN_ESTIMATE = 4;
  const inputTokensEstimate = Math.ceil(Math.max(0, inputCharacterCount) / CHARS_PER_TOKEN_ESTIMATE);
  return [
    { metricKey: 'input_text_tokens', quantity: inputTokensEstimate },
    { metricKey: 'output_text_tokens', quantity: Math.max(0, maxOutputTokens) },
  ];
}

/**
 * Same as estimateTextTokens, but derives inputCharacterCount from a real
 * OpenAI chat `messages` array already built by the caller — for call sites
 * where summing individual prompt-string variables is less natural than
 * reading the array that's about to be sent anyway (e.g. a shared helper
 * that accepts the full request params). Never reads anything beyond
 * `.content` string lengths; non-string content (should not occur for this
 * app's text-only chat completions) is safely treated as zero rather than
 * throwing.
 */
export function estimateTextTokensFromMessages(
  messages: ReadonlyArray<{ content?: unknown }>,
  maxOutputTokens: number,
): MetricEstimate[] {
  const inputCharacterCount = messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
  return estimateTextTokens(inputCharacterCount, maxOutputTokens);
}

/** provider_requests: the maximum number of physical attempts the calling flow can make (its own retry ceiling), never an assumption of exactly one. */
export function estimateProviderRequests(maxPhysicalAttempts: number): MetricEstimate {
  return { metricKey: 'provider_requests', quantity: Math.max(1, maxPhysicalAttempts) };
}

/**
 * Ceiling used by call sites (writing.correct/correct_review,
 * writing.compare_rewrite/correct_v2_text, listening.episode_generate_questions/
 * episode_translate_subtitles) that never pass an explicit max_tokens/
 * max_completion_tokens to OpenAI — the model's own default cap applies at
 * the provider, which is typically higher than this. Matches the ceiling
 * this app's own other call sites already use explicitly for similarly-
 * shaped short JSON-feedback responses (see story_session_generate's
 * max_tokens: 2000) rounded up for safety — a genuine upper bound, not a
 * claim of precision (Fase 6: "não alegar precisão exata se for upper bound").
 */
export const DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE = 4096;
