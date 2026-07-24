/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 * Central type definitions for the AI Gateway.
 */

import type { AiFeatureKey, ExecutionLocation } from './feature-catalog';

export type { AiFeatureKey, ExecutionLocation };

export type AiProvider = 'openai' | 'azure';

export type GatewayMode = 'legacy' | 'observe' | 'enforce';

// circuit_open / maintenance are additive (Etapa 11): a breaker or a manual
// maintenance window can now express itself through the same runtime_status
// column ai_runtime_controls already had, without a new column or table.
export type RuntimeStatus = 'enabled' | 'cache_only' | 'disabled' | 'paused_automatically' | 'circuit_open' | 'maintenance';

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
  // Etapa 11 — additive, optional. Sourced from ai_runtime_controls'
  // pre-existing daily_budget_usd/monthly_budget_usd/max_concurrent_requests/
  // rate_limit_requests/rate_limit_window_seconds columns (foundation
  // migration; NULL today at every seeded row = unlimited, no plan
  // hardcoded). Resolved with the same most-specific-scope-wins precedence
  // as gatewayMode. Only consulted by the enforce-mode pipeline
  // (enforcement.ts), unreachable in production this stage.
  dailyBudgetUsd?: string | null;
  monthlyBudgetUsd?: string | null;
  // Which ai_runtime_controls scope actually produced the winning
  // dailyBudgetUsd/monthlyBudgetUsd value above (most-specific-wins per
  // field — see policy-resolver.ts's mostSpecificFieldValue). Needed so a
  // budget configured only at 'global' (or 'provider') is reserved against
  // ONE shared bucket, not silently re-labeled per-feature — see
  // enforcement.ts's buildBudgetScopes. Absent/null defaults to 'feature'
  // scope, preserving prior behavior for any caller that doesn't set it.
  dailyBudgetScopeType?: 'user' | 'feature' | 'provider' | 'global' | null;
  monthlyBudgetScopeType?: 'user' | 'feature' | 'provider' | 'global' | null;
  maxConcurrentRequests?: number | null;
  rateLimitRequests?: number | null;
  rateLimitWindowSeconds?: number | null;
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
  // Etapa 11 — enforce-mode only. Pre-call estimate for reservation sizing;
  // optional and additive. No existing call site sets this (all remain
  // legacy/observe), so it changes nothing until a caller opts in AND the
  // feature is switched to enforce (not done in this stage).
  estimatedMetrics?: Array<{ metricKey: string; quantity: number }>;
  estimatedCostUsd?: string | null;
  maxPhysicalAttempts?: number;
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

// ── Entitlements (Etapa 11) ───────────────────────────────────────────────────
// Server-only resolution of what a userId/actorType is currently allowed to
// do for a featureKey. Authored entirely by the dashboard (plans,
// plan_versions, capability_definitions, plan_capability_values,
// user_plan_assignments, user_capability_overrides, user_access_controls) —
// this Gateway never writes to those tables and never accepts a planId from
// the client. actorType='system' bypasses plan resolution entirely.

export type EntitlementSource =
  | 'plan'                 // resolved from the user's active/default plan
  | 'override'              // a user_capability_overrides row changed the plan value
  | 'system_actor'          // actorType=system — no plan involved
  | 'no_plan_configured'    // dashboard has no plan system data for this capability yet
  | 'fallback_error';       // resolution failed — fail-open default used

export interface EntitlementLimit {
  metricKey: string;
  limit: number | null;      // null = unlimited
  period: 'none' | 'request' | 'day' | 'week' | 'month' | 'lifetime' | 'assignment_cycle';
  // periodStart/resetAt (=periodEnd) are both null exactly when period is
  // 'none'/'request' (no periodic bucket — per-call ceiling only). Present
  // together otherwise, resolved server-side (periods.ts) — never trust a
  // client-supplied period boundary. Correction to Etapa 11: needed so the
  // enforce pipeline can pass a real [periodStart, periodEnd) window into
  // reserve_gateway_usage_v1's accumulated-quota bucket, not just a
  // per-call ceiling.
  periodStart: string | null; // ISO timestamp
  resetAt: string | null;     // ISO timestamp — this limit's period end
}

export interface EffectiveEntitlement {
  allowed: boolean;          // false only for suspended users / disabled plan access
  userId: string | null;     // null for actorType=system
  actorType: ActorType;
  featureKey: AiFeatureKey;
  effectivePlanId: string | null;
  limits: EntitlementLimit[];
  source: EntitlementSource;
  revision: number | null;   // plan_version.revision or override count, for cache/debug
  resolvedAt: string;        // ISO timestamp of this resolution
}

// ── Decisions (Etapa 11) ──────────────────────────────────────────────────────
// A technical record of a gate's verdict — kill-switch, rate limit, dedupe,
// entitlement, budget, breaker. Recorded OUTSIDE ai_usage_events: a blocked
// attempt never became a physical provider call, so it must never be
// confused with one.

export type GatewayDecisionOutcome = 'allowed' | 'blocked' | 'would_block';

export interface GatewayDecisionRecord {
  outcome: GatewayDecisionOutcome;
  reasonCode: string;
  featureKey: string;
  provider?: string;
  userId?: string;
  actorType: ActorType;
  gatewayMode: GatewayMode;
  policyRevision?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>; // sanitized, technical only
}

// ── Reservations (Etapa 11) ───────────────────────────────────────────────────

// Matches usage_reservations.status's existing CHECK constraint values
// exactly (pending/committed/released/expired/cancelled, from the
// foundation migration) plus 'reconciliation_required', added additively
// in this stage's migration. "Reserved" in the Fase 5 spec language is this
// schema's pre-existing 'pending' — reused rather than duplicated.
export type ReservationStatus = 'pending' | 'committed' | 'released' | 'expired' | 'cancelled' | 'reconciliation_required';

export interface ReservationMetricEstimate {
  metricKey: string;
  quantity: number;
  // Accumulated-quota fields (correction to Etapa 11's original per-call-only
  // design). All three are optional and travel together: a metric with no
  // limitQuantity (or no period) skips the quota-bucket check entirely in
  // reserve_gateway_usage_v1 — only the per-call estimate is recorded. When
  // present, limitQuantity/periodStart/periodEnd are ALWAYS resolved
  // server-side (entitlements.ts + periods.ts), never trusted from a client.
  limitQuantity?: number | null;
  periodType?: 'day' | 'week' | 'month' | 'lifetime' | 'assignment_cycle' | null;
  periodStart?: string | null; // ISO
  periodEnd?: string | null;   // ISO
}

// One budget cap the reservation must be validated against, atomically,
// alongside every quota metric — see reserve_gateway_usage_v1's p_budget_scopes.
export interface ReservationBudgetScope {
  scopeType: 'user' | 'plan' | 'feature' | 'provider' | 'global';
  scopeKey: string;
  periodType: 'day' | 'month';
  periodStart: string; // ISO
  periodEnd: string;   // ISO
  limitUsd: string | null; // decimal string; null = unlimited, skips the check
}

export interface ReserveUsageParams {
  idempotencyKey: string;
  userId?: string;
  initiatedByUserId?: string;
  featureKey: AiFeatureKey;
  provider: string;
  model?: string;
  estimatedMetrics: ReservationMetricEstimate[];
  budgetScopes: ReservationBudgetScope[];
  estimatedCostUsd: string | null; // decimal string; null = unpriced
  expiresInSeconds: number;
}

// Real per-metric usage measured after invoke() — passed into commit() so
// the SQL layer can move the bucket's committed_quantity by the REAL amount
// (never the estimate) and release the reserved/actual difference.
export interface ReservationActualMetric {
  metricKey: string;
  quantity: number;
}

export interface ReservationResult {
  reservationId: string | null;
  status: ReservationStatus | 'blocked';
  expiresAt: string | null;
  blockedReason?: 'QUOTA_EXCEEDED' | 'BUDGET_EXCEEDED' | null;
  blockedDetail?: string | null;
}
