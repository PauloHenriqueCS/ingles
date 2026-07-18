/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Isolated cost-calculation component for the AI Gateway.
 *
 *   calculateEventCost  — pure: given an event + its persisted metrics +
 *                          a price lookup, computes per-metric costs.
 *                          No DB writes. Fully deterministic and idempotent:
 *                          recalculating the same inputs always yields the
 *                          same output.
 *
 *   reconcileEventCost  — DB I/O wrapper around calculateEventCost. Reads
 *                          the event and its metrics, computes costs, and
 *                          persists them. Used both by the live observe-mode
 *                          path (right after metrics are inserted) and by
 *                          manual/backfill reconciliation of pending events.
 *                          Server-only, id-only — never accepts a
 *                          client-supplied price.
 *
 * Runs only in observe mode. Legacy mode never reaches this module (the
 * gateway core returns before telemetry runs at all). A cost-calculation
 * failure is always caught by the caller and never affects the response
 * returned to the user.
 */

import { calculateLineCostUsd, sumDecimalStrings } from './decimal';
import { sanitizeMetadata, sanitizeError } from './sanitize';
import type { PricingRepositoryInterface } from './pricing-repository';
import type {
  UsageEventForCosting,
  UsageMetricForCosting,
  UsageRepositoryInterface,
} from './usage-repository';

// ── Cached-token split ─────────────────────────────────────────────────────────

export interface CachedSplitAnomaly {
  type: 'cached_exceeds_input';
  reportedCachedTokens: number;
  reportedInputTokens: number;
  cappedTo: number;
}

export interface CachedSplitResult {
  regularInputTokens: number;
  billedCachedTokens: number;
  anomaly: CachedSplitAnomaly | null;
}

/**
 * OpenAI's input_text_tokens total already includes cached_input_tokens.
 * Billing the full input total AND the cached amount would double-charge
 * the cached portion, so the regular (non-cached) share must be derived
 * by subtraction, floored at zero.
 */
export function splitCachedInputTokens(inputTextTokens: number, cachedInputTokens: number): CachedSplitResult {
  if (cachedInputTokens > inputTextTokens) {
    return {
      regularInputTokens: 0,
      billedCachedTokens: inputTextTokens,
      anomaly: {
        type: 'cached_exceeds_input',
        reportedCachedTokens: cachedInputTokens,
        reportedInputTokens: inputTextTokens,
        cappedTo: inputTextTokens,
      },
    };
  }
  return {
    regularInputTokens: Math.max(inputTextTokens - cachedInputTokens, 0),
    billedCachedTokens: cachedInputTokens,
    anomaly: null,
  };
}

// ── Cached-token split pairs ───────────────────────────────────────────────────
// Each pair is (total-tokens metric, cached-subset-of-that-total metric). The
// generic text pair is the original one used by every chat.completions
// feature; the audio pair exists for conversation.realtime_usage, whose
// provider event reports text and audio cache hits as separate sub-counters
// (input_token_details.cached_tokens_details.{text,audio}_tokens). Adding a
// pair here never changes behavior for metric keys that aren't in it.
const CACHE_SPLIT_PAIRS: ReadonlyArray<{ totalKey: string; cachedKey: string }> = [
  { totalKey: 'input_text_tokens', cachedKey: 'cached_input_tokens' },
  { totalKey: 'input_audio_tokens', cachedKey: 'cached_input_audio_tokens' },
];

// ── Pure calculation ─────────────────────────────────────────────────────────

export interface MetricCostResult {
  id: string;
  metricKey: string;
  billableQuantity: number | null;
  pricingId: string | null;
  calculatedCostUsd: string | null; // decimal string; null = no price found
  anomalyMetadata: Record<string, unknown> | null;
}

export interface CostCalculationOutcome {
  metricResults: MetricCostResult[];
  allBillableMetricsPriced: boolean;
  totalCostUsd: string | null; // only set when allBillableMetricsPriced
}

const CURRENCY = 'USD';

/**
 * Pure orchestration: no DB writes. `findActivePrice` and `logAnomaly` are
 * injected so this function has zero I/O of its own and is trivially unit
 * testable. Calling it twice with the same inputs and the same price
 * snapshot always returns the same output — the idempotency guarantee lives
 * here, not in the persistence layer.
 */
export async function calculateEventCost(
  event: UsageEventForCosting,
  metrics: UsageMetricForCosting[],
  pricingRepository: PricingRepositoryInterface,
  logAnomaly: (event: string, data?: Record<string, unknown>) => void,
): Promise<CostCalculationOutcome> {
  // Build a split for each cache pair actually present on this event (by
  // total-key), then index the result under both of its metric keys so the
  // per-metric loop below can look either one up in O(1).
  const splitsByMetricKey = new Map<string, CachedSplitResult>();
  for (const pair of CACHE_SPLIT_PAIRS) {
    const totalMetric = metrics.find((m) => m.metricKey === pair.totalKey);
    if (!totalMetric) continue;
    const cachedMetric = metrics.find((m) => m.metricKey === pair.cachedKey);
    const split = splitCachedInputTokens(totalMetric.quantity, cachedMetric?.quantity ?? 0);

    if (split.anomaly) {
      logAnomaly('gateway.cost.anomaly', {
        eventId: event.id,
        metricKey: pair.totalKey,
        ...split.anomaly,
      });
    }

    splitsByMetricKey.set(pair.totalKey, split);
    splitsByMetricKey.set(pair.cachedKey, split);
  }

  const metricResults: MetricCostResult[] = [];
  let allBillableMetricsPriced = true;
  const pricedCosts: string[] = [];

  for (const metric of metrics) {
    if (!metric.isBillable) {
      // Non-billable metrics (e.g. provider_requests) are never priced — no
      // price row is expected to exist for them, and their absence must not
      // be treated as "missing price for a billable metric". Cost is a
      // confirmed 0 (no separate charge), not an unknown/pending NULL.
      metricResults.push({
        id: metric.id,
        metricKey: metric.metricKey,
        billableQuantity: null,
        pricingId: null,
        calculatedCostUsd: '0',
        anomalyMetadata: null,
      });
      continue;
    }

    let billedQuantity = metric.quantity;
    let anomalyMetadata: Record<string, unknown> | null = null;

    const split = splitsByMetricKey.get(metric.metricKey);
    const pairForMetric = CACHE_SPLIT_PAIRS.find(
      (p) => p.totalKey === metric.metricKey || p.cachedKey === metric.metricKey,
    );
    if (split && pairForMetric?.totalKey === metric.metricKey) {
      billedQuantity = split.regularInputTokens;
    } else if (split && pairForMetric?.cachedKey === metric.metricKey) {
      billedQuantity = split.billedCachedTokens;
      if (split.anomaly) {
        anomalyMetadata = sanitizeMetadata({ anomaly: split.anomaly.type, cappedTo: split.anomaly.cappedTo });
      }
    }

    const price = await pricingRepository.findActivePrice({
      provider:  event.provider,
      service:   event.service,
      model:     event.model,
      metricKey: metric.metricKey,
      currency:  CURRENCY,
      at:        new Date(event.startedAt),
    });

    if (!price) {
      // No price found — never guess, never silently charge zero for a
      // billable metric. This metric stays unpriced; the event stays
      // pending until a price is registered and reconciliation re-runs.
      allBillableMetricsPriced = false;
      metricResults.push({
        id: metric.id,
        metricKey: metric.metricKey,
        billableQuantity: billedQuantity,
        pricingId: null,
        calculatedCostUsd: null,
        anomalyMetadata,
      });
      continue;
    }

    const cost = calculateLineCostUsd(billedQuantity, price.pricePerUnit, price.unitSize);
    pricedCosts.push(cost);
    metricResults.push({
      id: metric.id,
      metricKey: metric.metricKey,
      billableQuantity: billedQuantity,
      pricingId: price.id,
      calculatedCostUsd: cost,
      anomalyMetadata,
    });
  }

  return {
    metricResults,
    allBillableMetricsPriced,
    totalCostUsd: allBillableMetricsPriced && pricedCosts.length > 0 ? sumDecimalStrings(pricedCosts) : null,
  };
}

// ── DB-backed orchestration ───────────────────────────────────────────────────

export type ReconcileOutcome = 'calculated' | 'partial' | 'not_found';

export interface ReconcileDeps {
  usageRepository: UsageRepositoryInterface;
  pricingRepository: PricingRepositoryInterface;
  logger: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Recalculates and persists the cost of a single AI usage event, by id.
 * Idempotent: re-running against the same stored metrics and the same price
 * rows always overwrites with the same deterministic values — it never adds
 * to a running total. Never accepts a price from the caller; every price is
 * re-read from provider_pricing. Server-only — no HTTP route is exposed for
 * this in this stage.
 */
export async function reconcileEventCost(eventId: string, deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const event = await deps.usageRepository.getEventForCosting(eventId);
  if (!event) return 'not_found';

  const metrics = await deps.usageRepository.getMetricsForEvent(eventId);
  if (metrics.length === 0) return 'partial';

  const outcome = await calculateEventCost(event, metrics, deps.pricingRepository, deps.logger);

  for (const m of outcome.metricResults) {
    if (m.calculatedCostUsd === null) continue;
    try {
      await deps.usageRepository.updateMetricCost(m.id, {
        billableQuantity: m.billableQuantity ?? undefined,
        pricingId: m.pricingId ?? undefined,
        calculatedCostUsd: m.calculatedCostUsd,
        metadata: m.anomalyMetadata ?? undefined,
      });
    } catch (err) {
      deps.logger('gateway.cost.updateMetricCost.failed', sanitizeError(err));
    }
  }

  if (outcome.allBillableMetricsPriced && outcome.totalCostUsd !== null) {
    try {
      await deps.usageRepository.updateEventCost(eventId, {
        costStatus: 'calculated',
        calculatedCostUsd: outcome.totalCostUsd,
      });
      return 'calculated';
    } catch (err) {
      deps.logger('gateway.cost.updateEventCost.failed', sanitizeError(err));
      return 'partial';
    }
  }

  return 'partial';
}
