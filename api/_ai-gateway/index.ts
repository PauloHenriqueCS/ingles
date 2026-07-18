/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Public API of the AI Gateway. Import from this file only.
 */

// Feature catalog
export {
  AI_FEATURE_KEYS,
  FEATURE_METADATA,
  isValidFeatureKey,
  assertFeatureKey,
  getFeatureMeta,
} from './feature-catalog';
export type { AiFeatureKey, FeatureMeta, ExecutionLocation } from './feature-catalog';

// Central types
export type {
  AiProvider,
  GatewayMode,
  RuntimeStatus,
  ActorType,
  CostStatus,
  MetricKey,
  GatewayPolicy,
  GatewayCallContext,
  GatewayUsageMetric,
  GatewayResourceReference,
  ProviderSessionContext,
} from './types';

// Errors
export { GatewayError } from './errors';
export type { GatewayErrorCode } from './errors';

// Sanitization (for use by adapters when building metadata)
export { sanitizeMetadata, sanitizeError } from './sanitize';
export type { SanitizedError } from './sanitize';

// Policy resolver
export { GatewayPolicyResolver } from './policy-resolver';
export type { PolicyResolverInterface } from './policy-resolver';

// Usage repository
export { SupabaseUsageRepository, getSharedServiceClient, DuplicateUsageEventError } from './usage-repository';
export type {
  UsageRepositoryInterface,
  StartEventParams,
  CompleteEventParams,
  FailEventParams,
  CreateSessionParams,
  UsageEventForCosting,
  UsageMetricForCosting,
  UpdateMetricCostParams,
  UpdateEventCostParams,
} from './usage-repository';

// Pricing repository
export { SupabasePricingRepository } from './pricing-repository';
export type {
  PricingRepositoryInterface,
  PriceLookupParams,
  PriceLookupResult,
} from './pricing-repository';

// Cost calculator
export {
  calculateEventCost,
  reconcileEventCost,
  splitCachedInputTokens,
} from './cost-calculator';
export type {
  CachedSplitAnomaly,
  CachedSplitResult,
  MetricCostResult,
  CostCalculationOutcome,
  ReconcileOutcome,
  ReconcileDeps,
} from './cost-calculator';

// Decimal arithmetic
export {
  decimalToRational,
  multiplyRational,
  divideRational,
  addRational,
  rationalToDecimalString,
  calculateLineCostUsd,
  sumDecimalStrings,
} from './decimal';
export type { Rational } from './decimal';

// Daily rollup repository
export { SupabaseDailyRollupRepository } from './daily-rollup-repository';
export type {
  DailyRollupRepositoryInterface,
  DailyBucketDimensions,
  DailyBucketKey,
} from './daily-rollup-repository';

// Daily rollup orchestration
export {
  rebuildDailyBucketForEvent,
  reconcileDailyBucketsForDate,
} from './daily-rollup';
export type { DailyRollupDeps, ReconcileDateOutcome } from './daily-rollup';

// Provider sessions
export {
  authorizeProviderSession,
  activateProviderSession,
  completeProviderSession,
  failProviderSession,
  expireProviderSession,
} from './provider-sessions';
export type { AuthorizedSessionResult } from './provider-sessions';

// Gateway core
export {
  executeAiGatewayCall,
  getProductionDeps,
} from './gateway';
export type { GatewayDeps, MetricExtractor } from './gateway';

// ── Etapa 11 — enforcement layer ──────────────────────────────────────────────
// Unreachable in production this stage (no feature's gateway_mode is
// 'enforce'), but part of the Gateway's public surface for callers that need
// to check policy directly (e.g. the Realtime session-control poll route,
// which reuses evaluateKillSwitch + the entitlement resolver outside the
// executeAiGatewayCall wrapper — see api/conversation/[...slug].ts's
// handleSessionControl).

export { evaluateKillSwitch } from './kill-switch';
export type { KillSwitchDecision } from './kill-switch';

export { SupabaseDecisionsRepository, recordDecisionSafely } from './decisions';
export type { DecisionsRepositoryInterface } from './decisions';

export { SupabaseEntitlementResolver, CAPABILITY_KEY_BY_METRIC } from './entitlements';
export type { EntitlementResolverInterface } from './entitlements';

export { SupabaseRateLimiter } from './rate-limiter';
export type { RateLimiterInterface, RateLimitCheckResult } from './rate-limiter';

export { SupabaseDedupeStore, computeIdempotencyFingerprint } from './dedupe';
export type { DedupeStoreInterface, DedupeOutcome, DedupeBeginResult } from './dedupe';

export { SupabaseReservationsRepository } from './reservations';
export type { ReservationsRepositoryInterface } from './reservations';

export { SupabaseBudgetChecker } from './budgets';
export type { BudgetCheckerInterface, BudgetScope, BudgetPeriod, BudgetCheckParams, BudgetCheckResult } from './budgets';

export { SupabaseCircuitBreaker } from './circuit-breaker';
export type { CircuitBreakerInterface, BreakerState, BreakerStateResult } from './circuit-breaker';

export {
  estimateTtsCharacters,
  estimateAudioSecondsCeiling,
  estimateRealtimeSessionSeconds,
  estimateTextTokens,
  estimateTextTokensFromMessages,
  estimateProviderRequests,
  DEFAULT_MAX_OUTPUT_TOKENS_ESTIMATE,
} from './estimators';
export type { MetricEstimate } from './estimators';

export { executeEnforcedPipeline } from './enforcement';

export type {
  EntitlementSource,
  EntitlementLimit,
  EffectiveEntitlement,
  GatewayDecisionOutcome,
  GatewayDecisionRecord,
  ReservationStatus,
  ReservationMetricEstimate,
  ReserveUsageParams,
  ReservationResult,
} from './types';
