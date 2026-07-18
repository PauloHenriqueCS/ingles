/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * The enforce-mode pipeline (Etapa 11, Fase 5/11). Unreachable in
 * production at the end of this stage: no feature's gateway_mode is
 * 'enforce', and nothing in this delivery flips one. Exercised only by unit
 * tests, so that the day a feature IS switched to enforce, this code path
 * is already correct rather than a first attempt made under pressure.
 *
 * Pipeline: entitlement → budget → rate limit → dedupe → estimate → reserve
 * → invoke → measure → cost → commit/release → rollup → breaker. Fails
 * CLOSED before the provider call whenever any step cannot be positively
 * confirmed (POLICY_UNAVAILABLE) — enforce mode never "assumes yes." The
 * kill-switch itself is already checked by the caller (gateway.ts) before
 * this pipeline is ever entered, for every mode, so it is not repeated here.
 *
 * Known, deliberate simplifications (documented rather than hidden):
 *   - Quota check is a per-call ceiling (this call's estimatedMetrics vs.
 *     EntitlementLimit.limit), not a period-accumulated running total.
 *     Tracking "how much of this month's session_seconds has this user
 *     already consumed" would require summing ai_usage_event_metrics over
 *     the period — usage_daily only aggregates request counts and cost, not
 *     arbitrary per-metric quantities — and no such aggregation exists yet.
 *     Documented here rather than faking full protection (Fase 6: "não
 *     fingir proteção forte"); the preflight script must flag this.
 *   - Budget is checked at feature scope using GatewayPolicy's already-
 *     resolved (most-specific-scope-wins) daily/monthly limit, since the
 *     policy only carries the single winning value, not which scope
 *     produced it.
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
 *   - Reservation commit passes the call's estimatedCostUsd through as the
 *     recorded cost (UsageEventForCosting does not expose the
 *     already-persisted calculated_cost_usd for re-reading here); the
 *     authoritative cost remains whatever reconcileEventCost persisted on
 *     the event/metrics themselves — the reservation's committed amount is
 *     a best-effort mirror, not the source of truth.
 */

import { GatewayError, type GatewayErrorCode } from './errors';
import { recordDecisionSafely } from './decisions';
import type { GatewayDeps, MetricExtractor } from './gateway';
import { sanitizeError } from './sanitize';
import { reconcileEventCost } from './cost-calculator';
import { rebuildDailyBucketForEvent } from './daily-rollup';
import { getFeatureMeta, type AiFeatureKey } from './feature-catalog';
import type { GatewayCallContext, GatewayPolicy, GatewayUsageMetric } from './types';
import type { StartEventParams } from './usage-repository';

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
  for (const est of context.estimatedMetrics ?? []) {
    const lim = entitlement.limits.find((l) => l.metricKey === est.metricKey);
    if (lim && lim.limit !== null && est.quantity > lim.limit) {
      return deny('QUOTA_EXCEEDED', `Quota exceeded for ${est.metricKey}.`);
    }
  }

  // 2. Budget. policy.dailyBudgetUsd/monthlyBudgetUsd already reflect the
  // most-specific configured ai_runtime_controls row; NULL (the default)
  // means unlimited at that period and skips the check entirely.
  //
  // KNOWN GAP (documented, not hidden — see supabase/manual-validation/
  // ai-gateway-enforcement-concurrency.sql, "budget last-dollar race"):
  // this check and the reservation insert below are two separate round
  // trips, not one atomic operation. Two concurrent requests that both read
  // "within budget" a moment before the limit is reached can both pass this
  // check and both reserve — the budget can be oversubscribed by one
  // request's worth in that race window. Rate limiting, dedupe, and
  // reservation-row creation are each independently atomic (single SQL
  // statement, proven via the unique index / ON CONFLICT / row lock in
  // their respective RPCs — see the same validation file), but budget
  // enforcement across concurrent requests is NOT yet — closing this would
  // require folding the budget check into reserve_gateway_usage_v1's own
  // transaction (a real SQL redesign, out of scope for this delivery since
  // no feature reaches this code today). Must be fixed before any
  // budget-constrained feature is ever switched to enforce.
  if (deps.budgetChecker) {
    const now = new Date(deps.clock());
    const periods: Array<['day' | 'month', string | null]> = [
      ['day', policy.dailyBudgetUsd ?? null],
      ['month', policy.monthlyBudgetUsd ?? null],
    ];
    for (const [period, limitUsd] of periods) {
      if (limitUsd === null) continue;
      try {
        const budget = await deps.budgetChecker.check({
          scope: 'feature', scopeKey: featureKey, period, limitUsd,
          additionalEstimatedCostUsd: context.estimatedCostUsd ?? null,
        }, now);
        if (!budget.withinBudget) return deny('BUDGET_EXCEEDED', `Budget exceeded for ${featureKey} (${period}).`);
      } catch {
        return deny('POLICY_UNAVAILABLE', 'Budget check unavailable — failing closed.');
      }
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

  // 5/6. Estimate + reserve.
  const estimatedMetrics = context.estimatedMetrics ?? [{ metricKey: 'provider_requests', quantity: context.maxPhysicalAttempts ?? 1 }];
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
        estimatedCostUsd: context.estimatedCostUsd ?? null,
        expiresInSeconds: 120,
      });
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

  // 8/9/10/11/12/13. Measure, cost, commit, rollup, breaker.
  if (eventId !== undefined) {
    try {
      const latencyMs = deps.clock() - startedAt;
      await deps.usageRepository.completeEvent(eventId, { latencyMs });

      let metrics: GatewayUsageMetric[] = [];
      if (extractMetrics) {
        try { metrics = extractMetrics(result); }
        catch (extractErr) { deps.logger('gateway.enforce.extractMetrics.failed', sanitizeError(extractErr)); }
      }
      if (metrics.length > 0) await deps.usageRepository.insertMetrics(eventId, metrics);

      try {
        await reconcileEventCost(eventId, { usageRepository: deps.usageRepository, pricingRepository: deps.pricingRepository, logger: deps.logger });
      } catch (costErr) { deps.logger('gateway.enforce.cost.failed', sanitizeError(costErr)); }

      if (reservationId && deps.reservationsRepository) {
        try {
          // Real usage now known; confirm the reservation against the
          // actual event. The estimate is passed as the committed cost
          // mirror — see the module-level doc comment on why the exact
          // persisted calculated_cost_usd isn't re-read here.
          await deps.reservationsRepository.commit(reservationId, eventId, context.estimatedCostUsd ?? null);
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
