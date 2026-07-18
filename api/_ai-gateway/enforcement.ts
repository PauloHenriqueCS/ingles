/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * The enforce-mode pipeline (Etapa 11, Fase 5/11 — corrected). Unreachable
 * in production this stage: no feature's gateway_mode is 'enforce', and
 * nothing in this delivery flips one. Exercised only by unit tests, so that
 * the day a feature IS switched to enforce, this code path is already
 * correct rather than a first attempt made under pressure.
 *
 * Pipeline order (fixed by the Etapa 11 correction, §7): entitlement →
 * breaker gate → rate limit → dedupe → estimate → atomic quota+budget+
 * reserve → invoke → measure → cost → commit/release → rollup → breaker
 * outcome. The kill-switch itself is already checked by the caller
 * (gateway.ts) before this pipeline is ever entered, for every mode, so it
 * is not repeated here.
 *
 * Quota and budget are validated AND reserved together, in one round trip
 * to reserve_gateway_usage_v1 (see the migration) — closing the
 * last-dollar/last-unit concurrency race that existed when budget and
 * reservation were two separate operations. Quota is accumulated per
 * period (ai_gateway_quota_buckets: committed + reserved vs. limit), not
 * just a per-call ceiling — a single call whose own estimate already
 * exceeds the limit is still rejected by the very same check, so "limite
 * por chamada" is a special case of this, not a separate step.
 *
 * Known, deliberate simplifications (documented rather than hidden):
 *   - Dedupe: a 'completed' prior lock is reported as DUPLICATE_IN_PROGRESS
 *     (the closest fit in the fixed error-code list) because this generic,
 *     feature-agnostic pipeline has no stored T to replay — "não armazenar
 *     resposta da IA dentro do Gateway apenas para replay" is honored by
 *     design; a caller that needs true idempotent replay checks its own
 *     domain table before ever calling executeAiGatewayCall.
 *   - Circuit breaker: any invoke() rejection is treated as a provider
 *     failure signal here, since this generic pipeline cannot distinguish
 *     "provider timeout" from "provider returned a validation error" without
 *     feature-specific cooperation.
 */

import { GatewayError, type GatewayErrorCode } from './errors';
import { recordDecisionSafely } from './decisions';
import type { GatewayDeps, MetricExtractor } from './gateway';
import { sanitizeError } from './sanitize';
import { reconcileEventCost } from './cost-calculator';
import { rebuildDailyBucketForEvent } from './daily-rollup';
import { getFeatureMeta, type AiFeatureKey } from './feature-catalog';
import { dayBoundsUtc, monthBoundsUtc } from './periods';
import type { GatewayCallContext, GatewayPolicy, GatewayUsageMetric, ReservationBudgetScope, ReservationMetricEstimate } from './types';
import type { StartEventParams } from './usage-repository';

/**
 * Builds the budget scopes to validate/reserve against, from the already-
 * resolved policy (ai_runtime_controls' most-specific-scope-wins daily/
 * monthly limits) plus the feature/provider/global scopes. Applies equally
 * to system actors (§ correction item 18: "actor system continua sujeito a
 * budgets globais/provider/feature") — nothing here branches on actorType,
 * only on which scopes have a configured limit.
 */
function buildBudgetScopes(policy: GatewayPolicy, featureKey: AiFeatureKey, now: Date): ReservationBudgetScope[] {
  const scopes: ReservationBudgetScope[] = [];
  if (policy.dailyBudgetUsd == null && policy.monthlyBudgetUsd == null) return scopes;

  const { start: dayStart, end: dayEnd } = dayBoundsUtc(now);
  const { start: monthStart, end: monthEnd } = monthBoundsUtc(now);

  // policy.dailyBudgetUsd/monthlyBudgetUsd already reflect the
  // most-specific configured ai_runtime_controls row (user > feature >
  // provider > global precedence) — applied here at 'feature' scope, since
  // GatewayPolicy carries only the single winning value, not which scope
  // produced it (documented limitation, unchanged from before this
  // correction — closing it fully would require carrying the winning
  // scope_type/scope_key through GatewayPolicy, a larger change).
  if (policy.dailyBudgetUsd != null) {
    scopes.push({ scopeType: 'feature', scopeKey: featureKey, periodType: 'day', periodStart: dayStart.toISOString(), periodEnd: dayEnd.toISOString(), limitUsd: policy.dailyBudgetUsd });
  }
  if (policy.monthlyBudgetUsd != null) {
    scopes.push({ scopeType: 'feature', scopeKey: featureKey, periodType: 'month', periodStart: monthStart.toISOString(), periodEnd: monthEnd.toISOString(), limitUsd: policy.monthlyBudgetUsd });
  }
  return scopes;
}

export async function executeEnforcedPipeline<T>(
  featureKey: AiFeatureKey,
  context: GatewayCallContext,
  invoke: () => Promise<T>,
  deps: GatewayDeps,
  policy: GatewayPolicy,
  extractMetrics?: MetricExtractor<T>,
): Promise<T> {
  const meta = getFeatureMeta(featureKey);
  const correlationId = context.correlationId ?? deps.uuidGen();

  const deny = async (code: GatewayErrorCode, message: string): Promise<never> => {
    await recordDecisionSafely(deps.decisionsRepository, {
      outcome: 'blocked', reasonCode: code, featureKey, provider: context.provider,
      userId: context.userId, actorType: context.actorType, gatewayMode: 'enforce', correlationId,
    }, deps.logger);
    throw new GatewayError(code, message);
  };

  // 1. Entitlement.
  if (!deps.entitlementResolver) return deny('POLICY_UNAVAILABLE', 'Entitlement resolver unavailable — failing closed.');
  const metricKeysToCheck = (context.estimatedMetrics ?? []).map((m) => m.metricKey);
  const entitlement = await deps.entitlementResolver.resolve(context.userId, context.actorType, featureKey, metricKeysToCheck);
  if (entitlement.source === 'fallback_error') return deny('POLICY_UNAVAILABLE', 'Entitlement resolution failed — failing closed.');
  if (!entitlement.allowed) return deny('USER_BLOCKED', 'This account is currently blocked.');

  // 2. Circuit breaker gate — before rate limit/dedupe/reserve/provider, per
  // the corrected pipeline order. Manual kill-switch (checked by the caller
  // before this pipeline) always prevails; this is the automatic breaker.
  if (deps.circuitBreaker) {
    try {
      const breaker = await deps.circuitBreaker.getState(context.provider, context.model ?? null, featureKey);
      if (!breaker.probeAllowed) return deny('CIRCUIT_OPEN', `AI feature "${featureKey}" is temporarily unavailable (circuit open). No provider call was made.`);
    } catch {
      return deny('POLICY_UNAVAILABLE', 'Circuit breaker state unavailable — failing closed.');
    }
  }

  // 3. Rate limit — only when this scope has a configured ceiling
  // (ai_runtime_controls.rate_limit_requests); unconfigured (NULL, the
  // default) applies no gateway-level rate limit to this feature yet.
  if (context.userId && deps.rateLimiter && policy.rateLimitRequests != null) {
    try {
      const rl = await deps.rateLimiter.check(
        context.userId, featureKey,
        policy.rateLimitWindowSeconds ?? 3600, policy.rateLimitRequests,
      );
      if (!rl.allowed) return deny('RATE_LIMITED', 'Rate limit exceeded.');
    } catch {
      return deny('POLICY_UNAVAILABLE', 'Rate limiter unavailable — failing closed.');
    }
  }

  // 4. Dedupe.
  let dedupeLockId: string | null = null;
  if (context.idempotencyKey && deps.dedupeStore) {
    try {
      const begin = await deps.dedupeStore.begin(featureKey, context.idempotencyKey, 120);
      if (begin.outcome === 'in_progress' || begin.outcome === 'completed') {
        return deny('DUPLICATE_IN_PROGRESS', 'This action is already being processed.');
      }
      dedupeLockId = begin.lockId;
    } catch {
      return deny('POLICY_UNAVAILABLE', 'Dedupe store unavailable — failing closed.');
    }
  }

  // 5/6. Estimate + atomic quota+budget+reserve. Every estimated metric that
  // has a resolved entitlement limit carries its real [periodStart,
  // periodEnd) window into the reservation, so the accumulated bucket (not
  // just this call's own ceiling) is what's actually validated.
  const now = new Date(deps.clock());
  const estimatedMetricsInput = context.estimatedMetrics ?? [{ metricKey: 'provider_requests', quantity: context.maxPhysicalAttempts ?? 1 }];
  const estimatedMetrics: ReservationMetricEstimate[] = estimatedMetricsInput.map((est) => {
    const lim = entitlement.limits.find((l) => l.metricKey === est.metricKey);
    if (!lim || lim.limit === null || lim.periodStart === null || lim.resetAt === null) {
      return { metricKey: est.metricKey, quantity: est.quantity };
    }
    return {
      metricKey: est.metricKey, quantity: est.quantity,
      limitQuantity: lim.limit, periodType: lim.period === 'assignment_cycle' ? 'assignment_cycle' : (lim.period as 'day' | 'week' | 'month' | 'lifetime'),
      periodStart: lim.periodStart, periodEnd: lim.resetAt,
    };
  });
  const budgetScopes = buildBudgetScopes(policy, featureKey, now);

  let reservationId: string | null = null;
  if (deps.reservationsRepository) {
    try {
      const reservation = await deps.reservationsRepository.reserve({
        idempotencyKey: context.idempotencyKey ?? deps.uuidGen(),
        userId: context.userId,
        initiatedByUserId: context.initiatedByUserId,
        featureKey,
        provider: context.provider,
        model: context.model,
        estimatedMetrics,
        budgetScopes,
        estimatedCostUsd: context.estimatedCostUsd ?? null,
        expiresInSeconds: 120,
      });
      if (reservation.status === 'blocked') {
        if (dedupeLockId) await deps.dedupeStore!.fail(dedupeLockId).catch(() => undefined);
        const code: GatewayErrorCode = reservation.blockedReason === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'QUOTA_EXCEEDED';
        return deny(code, `${code === 'BUDGET_EXCEEDED' ? 'Budget' : 'Quota'} exceeded${reservation.blockedDetail ? ` for ${reservation.blockedDetail}` : ''}.`);
      }
      reservationId = reservation.reservationId;
    } catch {
      if (dedupeLockId) await deps.dedupeStore!.fail(dedupeLockId).catch(() => undefined);
      return deny('RESERVATION_FAILED', 'Could not reserve capacity for this request.');
    }
  }

  await recordDecisionSafely(deps.decisionsRepository, {
    outcome: 'allowed', reasonCode: 'OK', featureKey, provider: context.provider,
    userId: context.userId, actorType: context.actorType, gatewayMode: 'enforce', correlationId,
  }, deps.logger);

  // 7. Invoke — the actual physical call.
  const requestId = deps.uuidGen();
  const startedAt = deps.clock();
  const startParams: StartEventParams = {
    requestId, correlationId,
    idempotencyKey: context.idempotencyKey,
    userId: context.userId, initiatedByUserId: context.initiatedByUserId, actorType: context.actorType,
    featureKey, provider: context.provider, service: context.service, model: context.model,
    executionLocation: context.executionLocation, isBillable: meta.isBillable,
    attemptNumber: context.attemptNumber ?? 1, callSequence: context.callSequence ?? 1,
    operationPart: context.operationPart, resourceType: context.resourceType, resourceId: context.resourceId,
    metadata: {}, startedAt,
  };

  let eventId: string | undefined;
  try {
    eventId = await deps.usageRepository.startEvent(startParams);
  } catch (telErr) {
    deps.logger('gateway.enforce.startEvent.failed', sanitizeError(telErr));
  }

  let result: T;
  try {
    result = await invoke();
  } catch (invokeErr) {
    if (eventId !== undefined) {
      try {
        const latencyMs = deps.clock() - startedAt;
        const errInfo = sanitizeError(invokeErr, { provider: context.provider, model: context.model, latencyMs });
        await deps.usageRepository.failEvent(eventId, {
          latencyMs, httpStatus: errInfo.httpStatus, errorCode: errInfo.code,
          errorCategory: errInfo.category, sanitizedErrorMessage: errInfo.sanitizedMessage,
        });
      } catch (telErr) { deps.logger('gateway.enforce.failEvent.failed', sanitizeError(telErr)); }
    }
    // Provider error before consumption was ever confirmed → release the
    // reservation in full (Fase 5 rule). Reservation-release failure itself
    // must not mask the original provider error the caller needs to see.
    if (reservationId && deps.reservationsRepository) {
      try { await deps.reservationsRepository.release(reservationId, 'provider_error'); }
      catch (relErr) { deps.logger('gateway.enforce.releaseOnError.failed', sanitizeError(relErr)); }
    }
    if (dedupeLockId && deps.dedupeStore) await deps.dedupeStore.fail(dedupeLockId).catch(() => undefined);
    if (deps.circuitBreaker) {
      await deps.circuitBreaker.recordOutcome(context.provider, context.model ?? null, featureKey, false).catch(() => undefined);
    }
    throw invokeErr;
  }

  // 8/9/10/11/12. Measure, cost, commit, rollup, breaker.
  let realMetrics: GatewayUsageMetric[] = [];
  if (eventId !== undefined) {
    try {
      const latencyMs = deps.clock() - startedAt;
      await deps.usageRepository.completeEvent(eventId, { latencyMs });

      if (extractMetrics) {
        try { realMetrics = extractMetrics(result); }
        catch (extractErr) { deps.logger('gateway.enforce.extractMetrics.failed', sanitizeError(extractErr)); }
      }
      if (realMetrics.length > 0) await deps.usageRepository.insertMetrics(eventId, realMetrics);

      try {
        await reconcileEventCost(eventId, { usageRepository: deps.usageRepository, pricingRepository: deps.pricingRepository, logger: deps.logger });
      } catch (costErr) { deps.logger('gateway.enforce.cost.failed', sanitizeError(costErr)); }

      if (reservationId && deps.reservationsRepository) {
        try {
          // Real usage now known — commit moves each bucket's
          // committed_quantity by the ACTUAL amount (never the estimate)
          // and releases the reserved/actual difference; an overage (real >
          // reserved) is still fully committed, never silently dropped.
          const actualMetrics = realMetrics.map((m) => ({ metricKey: m.metricKey, quantity: m.quantity }));
          await deps.reservationsRepository.commit(reservationId, eventId, context.estimatedCostUsd ?? null, actualMetrics);
        } catch (commitErr) {
          deps.logger('gateway.enforce.reservationCommit.failed', sanitizeError(commitErr));
          // Provider responded and was already persisted, but confirming the
          // reservation itself failed — never silently release capacity that
          // may have genuinely been consumed (Fase 5 rule).
          await deps.reservationsRepository.markReconciliationRequired(reservationId, 'commit_failed_after_success').catch(() => undefined);
        }
      }

      try { await rebuildDailyBucketForEvent(eventId, { dailyRollupRepository: deps.dailyRollupRepository, logger: deps.logger }); }
      catch (rollupErr) { deps.logger('gateway.enforce.dailyRollup.failed', sanitizeError(rollupErr)); }
    } catch (telErr) {
      deps.logger('gateway.enforce.completeEvent.failed', sanitizeError(telErr));
    }
  }

  if (dedupeLockId && deps.dedupeStore) await deps.dedupeStore.complete(dedupeLockId, eventId ?? null).catch(() => undefined);
  if (deps.circuitBreaker) {
    await deps.circuitBreaker.recordOutcome(context.provider, context.model ?? null, featureKey, true).catch(() => undefined);
  }

  return result;
}
