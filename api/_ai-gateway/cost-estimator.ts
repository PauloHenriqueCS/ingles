/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Centralized conservative pre-call cost estimation for the enforce-mode
 * reservation pipeline (enforcement.ts).
 *
 * The bug this closes: no caller of executeAiGatewayCall has ever populated
 * context.estimatedCostUsd (confirmed by reading every call site — see the
 * "Budget-enforcement correction" comment on the commit() call in
 * enforcement.ts). reserve_gateway_usage_v1's budget check reads
 * COALESCE(p_estimated_cost_usd, 0) — a NULL estimate was silently treated
 * as "this call costs $0", so a single call whose OWN worst-case cost
 * already exceeds the remaining budget was never blocked; only an unrelated
 * LATER call, once enough committed spend had piled up, could ever trip the
 * gate ("bloqueia na próxima chamada", explicitly not an acceptable fix).
 *
 * Fix: derive a real, conservative USD figure here, ONCE, centrally — never
 * duplicated per-feature — from the SAME per-call ceiling quantities the
 * features already build for quota purposes (Fase 6, estimators.ts:
 * "usado apenas para dimensionar uma reserva antes de chamar um provider")
 * multiplied by real provider_pricing rows. Callers do not need their own
 * cost math; they only need an accurate estimatedMetrics ceiling, which is
 * the pre-existing Fase 6 contract.
 *
 * provider_requests is the one metric key every real call site in this
 * codebase always records as isBillable: false (see feature-catalog.ts's
 * FEATURE_METADATA plus every buildXMetrics() function across api/ — no
 * provider_pricing row is ever expected to exist for it). Every OTHER
 * metric key in a call's estimatedMetrics MUST resolve an active price or
 * the whole estimate is reported unresolved — never silently treated as
 * $0. The caller must fail closed on an unresolved estimate against any
 * budget scope that actually has a configured limit (see
 * reserve_gateway_usage_v1's matching fix in
 * 20260724030000_ai_gateway_conservative_budget_estimate_fix.sql) — an
 * unpriced billable metric is "we cannot prove this call is affordable",
 * never "this call is free".
 */

import type { PricingRepositoryInterface } from './pricing-repository';
import { calculateLineCostUsd, sumDecimalStrings } from './decimal';

// Confirmed by every real usage site in this repo (buildRealtimeUsageMetrics,
// buildCreateSessionMetrics, buildPreviewTtsMetrics, extractTokenMetrics,
// handleSessionActive/Failed, etc.) to always be isBillable: false. Kept as
// an explicit, documented allowlist rather than inferred from "no price
// found" — the latter would make a genuinely mispriced billable metric
// indistinguishable from an intentionally free one.
const ALWAYS_FREE_METRIC_KEYS: ReadonlySet<string> = new Set(['provider_requests']);

export interface ConservativeCostEstimateMetric {
  metricKey: string;
  quantity: number;
}

export interface ConservativeCostEstimateInput {
  provider: string;
  service?: string | null;
  model?: string | null;
  metrics: ReadonlyArray<ConservativeCostEstimateMetric>;
}

export type ConservativeCostEstimateOutcome =
  | { resolved: true; totalCostUsd: string }
  // unpricedMetricKey: the first metric (in input order) whose price could
  // not be resolved — enough for callers/logs to say WHY the estimate is
  // unresolved without needing to re-run the loop themselves.
  | { resolved: false; unpricedMetricKey: string };

/**
 * Pure-ish orchestration (its only I/O is pricingRepository.findActivePrice,
 * already read-only and side-effect-free) — safe to call on every enforce-
 * mode reservation attempt, including ones that end up blocked.
 */
export async function estimateConservativeCostUsd(
  input: ConservativeCostEstimateInput,
  pricingRepository: PricingRepositoryInterface,
  now: Date,
): Promise<ConservativeCostEstimateOutcome> {
  const parts: string[] = [];

  for (const metric of input.metrics) {
    if (ALWAYS_FREE_METRIC_KEYS.has(metric.metricKey)) continue;
    // A zero (or negative/invalid, clamped elsewhere before reaching here)
    // ceiling quantity contributes nothing and needs no price lookup —
    // consistent with calculateLineCostUsd's own quantity × price shape.
    if (!(metric.quantity > 0)) continue;

    const price = await pricingRepository.findActivePrice({
      provider: input.provider,
      service: input.service ?? null,
      model: input.model ?? null,
      metricKey: metric.metricKey,
      currency: 'USD',
      at: now,
    });
    if (!price) {
      return { resolved: false, unpricedMetricKey: metric.metricKey };
    }
    parts.push(calculateLineCostUsd(metric.quantity, price.pricePerUnit, price.unitSize));
  }

  return { resolved: true, totalCostUsd: parts.length > 0 ? sumDecimalStrings(parts) : '0' };
}
