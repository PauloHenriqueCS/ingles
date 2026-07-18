/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 * Central type definitions for the AI Gateway.
 */

import type { AiFeatureKey, ExecutionLocation } from './feature-catalog';

export type { AiFeatureKey, ExecutionLocation };

export type AiProvider = 'openai' | 'azure';

export type GatewayMode = 'legacy' | 'observe' | 'enforce';

export type RuntimeStatus = 'enabled' | 'cache_only' | 'disabled' | 'paused_automatically';

export type ActorType = 'user' | 'system' | 'cron' | 'admin';

export type CostStatus =
  | 'pending'
  | 'not_applicable'
  | 'estimated'
  | 'calculated'
  | 'reconciled'
  | 'unavailable';

// ── Policy ────────────────────────────────────────────────────────────────────

export interface GatewayPolicy {
  gatewayMode: GatewayMode;
  runtimeStatus: RuntimeStatus;
}

// ── Call context ──────────────────────────────────────────────────────────────
// NEVER include: prompt, user text, full response, transcript, audio,
// SSML, authorization tokens, or provider API keys.

export interface GatewayCallContext {
  featureKey: AiFeatureKey;
  provider: string;        // 'openai' | 'azure' | future providers
  service?: string;        // e.g. 'realtime', 'tts', 'chat'
  model?: string;
  userId?: string;
  initiatedByUserId?: string;
  actorType: ActorType;
  executionLocation: ExecutionLocation;
  correlationId?: string;
  idempotencyKey?: string;
  attemptNumber?: number;
  callSequence?: number;
  operationPart?: string;  // e.g. 'block_1', 'block_2' for multi-part TTS
  resourceType?: string;   // e.g. 'writing_entry', 'listening_episode'
  resourceId?: string;
  technicalMetadata?: Record<string, unknown>; // must be sanitized before storage
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export type MetricKey =
  | 'input_text_tokens'
  | 'output_text_tokens'
  | 'cached_input_tokens'
  | 'input_audio_tokens'
  | 'output_audio_tokens'
  // Realtime reports cached text and cached audio tokens as separate
  // sub-counters (input_token_details.cached_tokens_details), so the
  // generic 'cached_input_tokens' key (still used by chat.completions
  // features) is not enough on its own — this is the audio counterpart.
  | 'cached_input_audio_tokens'
  | 'tts_characters'
  | 'audio_seconds'
  | 'session_seconds'
  | 'audio_bytes'
  | 'provider_requests'
  | 'tokens_issued';

export interface GatewayUsageMetric {
  metricKey: MetricKey | string;
  unitType: string;
  quantity: number;
  billableQuantity?: number;
  isBillable: boolean;
  measurementSource: string;
  calculatedCostUsd?: number;    // NULL = unknown; do not invent values
  metadata?: Record<string, unknown>;
}

// ── Resource reference ────────────────────────────────────────────────────────

export interface GatewayResourceReference {
  resourceType: string;
  resourceId: string;
}

// ── Provider session context ──────────────────────────────────────────────────

export interface ProviderSessionContext {
  featureKey: AiFeatureKey;
  provider: string;
  userId?: string;           // NULL for system/cron sessions
  initiatedByUserId?: string;
  internalSessionType?: string;
  internalSessionId?: string;
  authorizationExpiresAt?: Date;
  metadata?: Record<string, unknown>;
}
