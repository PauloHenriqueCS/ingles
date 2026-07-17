/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Core AI Gateway execution function.
 *
 * Modes:
 *   legacy  — invoke once, no telemetry, no DB dependency on critical path.
 *   observe — invoke once, record events and metrics; telemetry failures
 *             never break the call.
 *   enforce — NOT YET IMPLEMENTED. Fails closed with a controlled error.
 *             No provider call is made.
 */

import { randomUUID } from 'crypto';
import {
  assertFeatureKey,
  getFeatureMeta,
  type AiFeatureKey,
} from './feature-catalog';
import { GatewayError } from './errors';
import { sanitizeMetadata, sanitizeError } from './sanitize';
import type { GatewayCallContext, GatewayPolicy, GatewayUsageMetric } from './types';
import { GatewayPolicyResolver, type PolicyResolverInterface } from './policy-resolver';
import { SupabaseUsageRepository, type UsageRepositoryInterface, type StartEventParams } from './usage-repository';
import { SupabasePricingRepository, type PricingRepositoryInterface } from './pricing-repository';
import { reconcileEventCost } from './cost-calculator';

// ── Dependency injection ──────────────────────────────────────────────────────

export interface GatewayDeps {
  policyResolver: PolicyResolverInterface;
  usageRepository: UsageRepositoryInterface;
  pricingRepository: PricingRepositoryInterface;
  clock: () => number;
  uuidGen: () => string;
  logger: (event: string, data?: Record<string, unknown>) => void;
}

// ── Metric extractor ──────────────────────────────────────────────────────────

export type MetricExtractor<T> = (result: T) => GatewayUsageMetric[];

// ── Default production deps ───────────────────────────────────────────────────

let _productionDeps: GatewayDeps | null = null;

export function getProductionDeps(): GatewayDeps {
  if (_productionDeps) return _productionDeps;

  _productionDeps = {
    policyResolver:    new GatewayPolicyResolver(),
    usageRepository:   new SupabaseUsageRepository(),
    pricingRepository: new SupabasePricingRepository(),
    clock:             () => Date.now(),
    uuidGen:           () => randomUUID(),
    logger:            (event, data) => {
      console.error(JSON.stringify({ gateway: event, ...data, t: Date.now() }));
    },
  };
  return _productionDeps;
}

// ── Core execution function ───────────────────────────────────────────────────

/**
 * Wraps a provider call with gateway policy enforcement and optional telemetry.
 *
 * @param context     Metadata about the call. MUST NOT include user content,
 *                    prompts, audio, or authorization tokens.
 * @param invoke      The actual provider call. Executed exactly once.
 * @param deps        Injectable dependencies (use getProductionDeps() in production).
 * @param extractMetrics  Optional extractor for usage metrics from the result.
 */
export async function executeAiGatewayCall<T>(
  context: GatewayCallContext,
  invoke: () => Promise<T>,
  deps: GatewayDeps,
  extractMetrics?: MetricExtractor<T>,
): Promise<T> {
  // 1. Validate feature key — throws GatewayError on unknown feature.
  const featureKey: AiFeatureKey = assertFeatureKey(context.featureKey);

  // 2. Resolve policy.
  let policy: GatewayPolicy;
  try {
    policy = await deps.policyResolver.resolvePolicy(context);
  } catch (policyErr) {
    deps.logger('gateway.policy.error', sanitizeError(policyErr));
    // Safe default: legacy (no-op) so the call can proceed.
    policy = { gatewayMode: 'legacy', runtimeStatus: 'enabled' };
  }

  // 3. Enforce mode — fails closed. No provider call is made.
  if (policy.gatewayMode === 'enforce') {
    throw new GatewayError(
      'AI_GATEWAY_ENFORCEMENT_NOT_READY',
      'Gateway enforcement mode is not yet implemented. No provider call was made.',
    );
  }

  // 4. Legacy mode — pass-through with zero database dependency.
  if (policy.gatewayMode === 'legacy') {
    return invoke();
  }

  // 5. Observe mode — record telemetry around the provider call.
  return executeWithTelemetry(featureKey, context, invoke, deps, extractMetrics);
}

// ── Observe mode internals ────────────────────────────────────────────────────

async function executeWithTelemetry<T>(
  featureKey: AiFeatureKey,
  context: GatewayCallContext,
  invoke: () => Promise<T>,
  deps: GatewayDeps,
  extractMetrics?: MetricExtractor<T>,
): Promise<T> {
  const requestId    = deps.uuidGen();
  const correlationId = context.correlationId ?? deps.uuidGen();
  const startedAt    = deps.clock();
  const meta         = getFeatureMeta(featureKey);

  const startParams: StartEventParams = {
    requestId,
    correlationId,
    idempotencyKey:      context.idempotencyKey,
    userId:              context.userId,
    initiatedByUserId:   context.initiatedByUserId,
    actorType:           context.actorType,
    featureKey,
    provider:            context.provider,
    service:             context.service,
    model:               context.model,
    executionLocation:   context.executionLocation,
    isBillable:          meta.isBillable,
    attemptNumber:       context.attemptNumber ?? 1,
    callSequence:        context.callSequence ?? 1,
    operationPart:       context.operationPart,
    resourceType:        context.resourceType,
    resourceId:          context.resourceId,
    metadata:            context.technicalMetadata
      ? sanitizeMetadata(context.technicalMetadata)
      : {},
    startedAt,
  };

  let eventId: string | undefined;
  try {
    eventId = await deps.usageRepository.startEvent(startParams);
  } catch (telErr) {
    // Telemetry start failure must not block the provider call.
    deps.logger('gateway.startEvent.failed', sanitizeError(telErr));
  }

  let result: T;
  try {
    result = await invoke();
  } catch (invokeErr) {
    if (eventId !== undefined) {
      try {
        const latencyMs = deps.clock() - startedAt;
        const errInfo   = sanitizeError(invokeErr, {
          provider: context.provider,
          model:    context.model,
          latencyMs,
        });
        await deps.usageRepository.failEvent(eventId, {
          latencyMs,
          httpStatus:             errInfo.httpStatus,
          errorCode:              errInfo.code,
          errorCategory:          errInfo.category,
          sanitizedErrorMessage:  errInfo.sanitizedMessage,
        });
      } catch (telErr) {
        deps.logger('gateway.failEvent.failed', sanitizeError(telErr));
      }
    }
    // Always re-throw the original error from invoke.
    throw invokeErr;
  }

  if (eventId !== undefined) {
    try {
      const latencyMs = deps.clock() - startedAt;
      await deps.usageRepository.completeEvent(eventId, { latencyMs });

      if (extractMetrics) {
        let metrics: GatewayUsageMetric[] = [];
        try {
          metrics = extractMetrics(result);
        } catch (extractErr) {
          // Extractor failure must not repeat the invoke call.
          deps.logger('gateway.extractMetrics.failed', sanitizeError(extractErr));
        }
        if (metrics.length > 0) {
          await deps.usageRepository.insertMetrics(eventId, metrics);

          // Cost calculation runs only after metrics are durably persisted,
          // and only ever in observe mode (this function is unreachable from
          // legacy). A failure here must never affect the response already
          // computed by invoke() above.
          try {
            await reconcileEventCost(eventId, {
              usageRepository:   deps.usageRepository,
              pricingRepository: deps.pricingRepository,
              logger:            deps.logger,
            });
          } catch (costErr) {
            deps.logger('gateway.cost.failed', sanitizeError(costErr));
          }
        }
      }
    } catch (telErr) {
      deps.logger('gateway.completeEvent.failed', sanitizeError(telErr));
    }
  }

  return result;
}
