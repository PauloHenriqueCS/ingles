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
export { SupabaseUsageRepository } from './usage-repository';
export type {
  UsageRepositoryInterface,
  StartEventParams,
  CompleteEventParams,
  FailEventParams,
  CreateSessionParams,
} from './usage-repository';

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
