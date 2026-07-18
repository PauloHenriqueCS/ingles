/**
 * Unit tests for the AI Gateway cost calculator.
 *
 * Pure logic only — no Supabase, no OpenAI. `calculateEventCost` is given a
 * fake, in-memory PricingRepositoryInterface that mimics the real SQL
 * selection semantics (provider+service+model+metric_key+currency, valid_from
 * inclusive / valid_until exclusive), so the orchestration itself is fully
 * exercised without a live database. The actual SQL in pricing-repository.ts
 * is validated manually against Supabase per the project's deploy process.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateEventCost,
  splitCachedInputTokens,
  type CostCalculationOutcome,
} from '../_ai-gateway/cost-calculator';
import { calculateLineCostUsd, sumDecimalStrings } from '../_ai-gateway/decimal';
import type { PricingRepositoryInterface, PriceLookupResult } from '../_ai-gateway/pricing-repository';
import type { UsageEventForCosting, UsageMetricForCosting } from '../_ai-gateway/usage-repository';

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface PriceRow {
  provider: string;
  service: string | null;
  model: string | null;
  metricKey: string;
  currency: string;
  pricePerUnit: string;
  unitSize: string;
  validFrom: string;
  validUntil: string | null;
}

const GPT4O_MINI_PRICES: PriceRow[] = [
  { provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini', metricKey: 'input_text_tokens', currency: 'USD', pricePerUnit: '0.15', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini', metricKey: 'cached_input_tokens', currency: 'USD', pricePerUnit: '0.075', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini', metricKey: 'output_text_tokens', currency: 'USD', pricePerUnit: '0.60', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
];

/** In-memory stand-in for provider_pricing, mirroring the real query's filters. */
function makeFakePricingRepository(rows: PriceRow[]): PricingRepositoryInterface {
  return {
    async findActivePrice(params): Promise<PriceLookupResult | null> {
      const at = params.at.toISOString();
      const candidates = rows.filter((r) =>
        r.provider === params.provider &&
        r.metricKey === params.metricKey &&
        r.currency === params.currency &&
        (r.service ?? null) === (params.service ?? null) &&
        (r.model ?? null) === (params.model ?? null) &&
        r.validFrom <= at && // inclusive
        (r.validUntil === null || r.validUntil > at), // exclusive
      );
      if (candidates.length === 0) return null;
      const top = [...candidates].sort((a, b) => (a.validFrom > b.validFrom ? -1 : 1))[0];
      return {
        id: `price:${top.metricKey}:${top.validFrom}`,
        pricePerUnit: top.pricePerUnit,
        unitSize: top.unitSize,
        currency: top.currency,
      };
    },
  };
}

function noopLogger() {}

function makeEvent(overrides: Partial<UsageEventForCosting> = {}): UsageEventForCosting {
  return {
    id: 'event-1',
    provider: 'openai',
    service: 'chat.completions',
    model: 'gpt-4o-mini',
    startedAt: '2026-07-17T12:00:00.000Z',
    costStatus: 'pending',
    ...overrides,
  };
}

function metric(id: string, metricKey: string, quantity: number, isBillable = true): UsageMetricForCosting {
  return { id, metricKey, quantity, isBillable };
}

const KNOWN_EVENT_METRICS: UsageMetricForCosting[] = [
  metric('m-input', 'input_text_tokens', 575),
  metric('m-output', 'output_text_tokens', 692),
  metric('m-requests', 'provider_requests', 1, false),
];

// ── 1. Input without cache ─────────────────────────────────────────────────────

describe('input tokens without cache', () => {
  it('bills the full input_text_tokens quantity at the regular price', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [metric('m-input', 'input_text_tokens', 575)],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const input = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    expect(input.billableQuantity).toBe(575);
    expect(input.calculatedCostUsd).toBe('0.00008625');
  });
});

// ── 2. Input with cache, no double charge ──────────────────────────────────────

describe('input tokens with cache — no double charge', () => {
  it('splits input_text_tokens into regular + cached, pricing each once', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [
        metric('m-input', 'input_text_tokens', 1000), // total reported by OpenAI, includes cached
        metric('m-cached', 'cached_input_tokens', 400),
      ],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const input = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    const cached = outcome.metricResults.find((m) => m.metricKey === 'cached_input_tokens')!;

    expect(input.billableQuantity).toBe(600); // 1000 - 400, never the full 1000
    expect(cached.billableQuantity).toBe(400);

    const expectedInputCost = calculateLineCostUsd(600, '0.15', '1000000');
    const expectedCachedCost = calculateLineCostUsd(400, '0.075', '1000000');
    expect(input.calculatedCostUsd).toBe(expectedInputCost);
    expect(cached.calculatedCostUsd).toBe(expectedCachedCost);

    // Sanity: the naive (wrong) double-charge total would be higher than ours.
    const wrongTotal = sumDecimalStrings([calculateLineCostUsd(1000, '0.15', '1000000'), expectedCachedCost]);
    const correctTotal = sumDecimalStrings([expectedInputCost, expectedCachedCost]);
    expect(correctTotal).not.toBe(wrongTotal);
    expect(outcome.totalCostUsd).toBe(correctTotal);
  });
});

// ── 3. Cache equal to total input ──────────────────────────────────────────────

describe('cache equal to total input', () => {
  it('bills zero regular input tokens and the full amount as cached, no negative', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [
        metric('m-input', 'input_text_tokens', 500),
        metric('m-cached', 'cached_input_tokens', 500),
      ],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const input = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    const cached = outcome.metricResults.find((m) => m.metricKey === 'cached_input_tokens')!;

    expect(input.billableQuantity).toBe(0);
    expect(input.calculatedCostUsd).toBe('0');
    expect(cached.billableQuantity).toBe(500);
    expect(Number(cached.calculatedCostUsd)).toBeGreaterThan(0);
  });
});

// ── 4. Cache greater than input — no negative cost ─────────────────────────────

describe('cache greater than reported input (anomalous)', () => {
  it('caps billed cache at the input total, never goes negative, logs one anomaly', async () => {
    const anomalies: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const outcome = await calculateEventCost(
      makeEvent(),
      [
        metric('m-input', 'input_text_tokens', 100),
        metric('m-cached', 'cached_input_tokens', 250),
      ],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      (event, data) => anomalies.push({ event, data }),
    );
    const input = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    const cached = outcome.metricResults.find((m) => m.metricKey === 'cached_input_tokens')!;

    expect(input.billableQuantity).toBe(0);
    expect(input.calculatedCostUsd).toBe('0');
    expect(cached.billableQuantity).toBe(100); // capped to input total, not 250
    expect(Number(cached.calculatedCostUsd)).toBeGreaterThanOrEqual(0);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].event).toBe('gateway.cost.anomaly');
    expect(anomalies[0].data?.type).toBe('cached_exceeds_input');
    expect(anomalies[0].data?.cappedTo).toBe(100);
  });

  it('splitCachedInputTokens is a pure, directly testable unit', () => {
    const result = splitCachedInputTokens(100, 250);
    expect(result.regularInputTokens).toBe(0);
    expect(result.billedCachedTokens).toBe(100);
    expect(result.anomaly).toEqual({
      type: 'cached_exceeds_input',
      reportedCachedTokens: 250,
      reportedInputTokens: 100,
      cappedTo: 100,
    });
  });

  it('no anomaly and no cap when cache does not exceed input', () => {
    const result = splitCachedInputTokens(575, 200);
    expect(result.regularInputTokens).toBe(375);
    expect(result.billedCachedTokens).toBe(200);
    expect(result.anomaly).toBeNull();
  });
});

// ── 5. Output tokens ────────────────────────────────────────────────────────────

describe('output tokens', () => {
  it('bills the full output_text_tokens quantity at the output price', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [metric('m-output', 'output_text_tokens', 692)],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const output = outcome.metricResults.find((m) => m.metricKey === 'output_text_tokens')!;
    expect(output.billableQuantity).toBe(692);
    expect(output.calculatedCostUsd).toBe('0.00041520');
  });
});

// ── 6. provider_requests — zero cost, not priced ───────────────────────────────

describe('provider_requests', () => {
  it('is confirmed zero cost, never priced, no pricingId', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [metric('m-requests', 'provider_requests', 1, false)],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const requests = outcome.metricResults.find((m) => m.metricKey === 'provider_requests')!;
    expect(requests.calculatedCostUsd).toBe('0');
    expect(requests.pricingId).toBeNull();
    // A non-billable metric never gates "all billable metrics priced".
    expect(outcome.allBillableMetricsPriced).toBe(true);
  });
});

// ── 7. Missing price never becomes silent zero ─────────────────────────────────

describe('missing price for a billable metric', () => {
  it('leaves calculatedCostUsd null and marks the event as not fully priced', async () => {
    const outcome = await calculateEventCost(
      makeEvent({ model: 'gpt-5-nonexistent' }), // no price row matches this model
      KNOWN_EVENT_METRICS,
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const input = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    expect(input.calculatedCostUsd).toBeNull();
    expect(input.pricingId).toBeNull();
    expect(outcome.allBillableMetricsPriced).toBe(false);
    expect(outcome.totalCostUsd).toBeNull();
  });
});

// ── 8. Price selection by event date ────────────────────────────────────────────

describe('price selection by event started_at', () => {
  const OLD_PRICE: PriceRow = {
    provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini', metricKey: 'input_text_tokens', currency: 'USD',
    pricePerUnit: '0.30', unitSize: '1000000',
    validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-07-17T00:00:00.000Z',
  };
  const NEW_PRICE: PriceRow = {
    provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini', metricKey: 'input_text_tokens', currency: 'USD',
    pricePerUnit: '0.15', unitSize: '1000000',
    validFrom: '2026-07-17T00:00:00.000Z', validUntil: null,
  };
  const repo = makeFakePricingRepository([OLD_PRICE, NEW_PRICE]);

  it('uses the price that was active when the event started (before the change)', async () => {
    const outcome = await calculateEventCost(
      makeEvent({ startedAt: '2026-03-01T00:00:00.000Z' }),
      [metric('m-input', 'input_text_tokens', 1000)],
      repo,
      noopLogger,
    );
    const input = outcome.metricResults[0];
    expect(input.calculatedCostUsd).toBe(calculateLineCostUsd(1000, '0.30', '1000000'));
  });

  it('uses the new price for an event started after the change', async () => {
    const outcome = await calculateEventCost(
      makeEvent({ startedAt: '2026-08-01T00:00:00.000Z' }),
      [metric('m-input', 'input_text_tokens', 1000)],
      repo,
      noopLogger,
    );
    const input = outcome.metricResults[0];
    expect(input.calculatedCostUsd).toBe(calculateLineCostUsd(1000, '0.15', '1000000'));
  });
});

// ── 9. valid_from inclusive, valid_until exclusive ─────────────────────────────

describe('validity boundaries', () => {
  const repo = makeFakePricingRepository([
    { provider: 'openai', service: 'chat.completions', model: 'gpt-4o-mini', metricKey: 'input_text_tokens', currency: 'USD', pricePerUnit: '0.15', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: '2026-08-01T00:00:00.000Z' },
  ]);

  it('an event started exactly at valid_from is priced (inclusive)', async () => {
    const outcome = await calculateEventCost(
      makeEvent({ startedAt: '2026-07-17T00:00:00.000Z' }),
      [metric('m-input', 'input_text_tokens', 100)],
      repo,
      noopLogger,
    );
    expect(outcome.metricResults[0].calculatedCostUsd).not.toBeNull();
  });

  it('an event started exactly at valid_until is NOT priced by that row (exclusive)', async () => {
    const outcome = await calculateEventCost(
      makeEvent({ startedAt: '2026-08-01T00:00:00.000Z' }),
      [metric('m-input', 'input_text_tokens', 100)],
      repo,
      noopLogger,
    );
    expect(outcome.metricResults[0].calculatedCostUsd).toBeNull();
  });

  it('an event started one millisecond before valid_until is priced', async () => {
    const outcome = await calculateEventCost(
      makeEvent({ startedAt: '2026-07-31T23:59:59.999Z' }),
      [metric('m-input', 'input_text_tokens', 100)],
      repo,
      noopLogger,
    );
    expect(outcome.metricResults[0].calculatedCostUsd).not.toBeNull();
  });
});

// ── 10. Idempotent recalculation ────────────────────────────────────────────────

describe('idempotent recalculation', () => {
  it('recalculating the same event twice produces byte-identical results', async () => {
    const repo = makeFakePricingRepository(GPT4O_MINI_PRICES);
    const run = () => calculateEventCost(makeEvent(), KNOWN_EVENT_METRICS, repo, noopLogger);

    const first = await run();
    const second = await run();

    expect(second).toEqual(first);
    expect(second.totalCostUsd).toBe(first.totalCostUsd);
  });

  it('does not accumulate — three sequential recalculations converge on one value', async () => {
    const repo = makeFakePricingRepository(GPT4O_MINI_PRICES);
    const results: (CostCalculationOutcome)[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(await calculateEventCost(makeEvent(), KNOWN_EVENT_METRICS, repo, noopLogger));
    }
    expect(results[0].totalCostUsd).toBe(results[1].totalCostUsd);
    expect(results[1].totalCostUsd).toBe(results[2].totalCostUsd);
  });
});

// ── 14. No student content anywhere in the output ─────────────────────────────

describe('no student text, prompt, or response in calculator output', () => {
  it('anomaly metadata contains only numeric/technical fields', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [
        metric('m-input', 'input_text_tokens', 50),
        metric('m-cached', 'cached_input_tokens', 999),
      ],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );
    const cached = outcome.metricResults.find((m) => m.metricKey === 'cached_input_tokens')!;
    expect(cached.anomalyMetadata).toBeDefined();
    expect(Object.keys(cached.anomalyMetadata ?? {}).sort()).toEqual(['anomaly', 'cappedTo']);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toMatch(/[a-zA-Z]{20,}/); // no long prose/text anywhere in the payload
  });
});

// ── 15. Known acceptance event → USD 0.00050145 ─────────────────────────────────

describe('acceptance test — known validated event', () => {
  it('575 input / 692 output / 0 cached tokens totals exactly USD 0.00050145', async () => {
    const outcome = await calculateEventCost(
      makeEvent(),
      [
        metric('m-input', 'input_text_tokens', 575),
        metric('m-output', 'output_text_tokens', 692),
        metric('m-requests', 'provider_requests', 1, false),
      ],
      makeFakePricingRepository(GPT4O_MINI_PRICES),
      noopLogger,
    );

    const input = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    const output = outcome.metricResults.find((m) => m.metricKey === 'output_text_tokens')!;
    const requests = outcome.metricResults.find((m) => m.metricKey === 'provider_requests')!;

    expect(input.calculatedCostUsd).toBe('0.00008625');
    expect(output.calculatedCostUsd).toBe('0.00041520');
    expect(requests.calculatedCostUsd).toBe('0');
    expect(outcome.allBillableMetricsPriced).toBe(true);
    expect(outcome.totalCostUsd).toBe('0.00050145');
  });
});

// ── 16. Realtime — audio cache-split pair (conversation.realtime_usage) ────────
// Regression guard: generalizing the cache split to support
// (input_audio_tokens, cached_input_audio_tokens) must never change the
// pre-existing (input_text_tokens, cached_input_tokens) behavior exercised
// above (tests 1–15 all still pass unmodified against the same code path).

const GPT_REALTIME_MINI_PRICES: PriceRow[] = [
  { provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini', metricKey: 'input_text_tokens', currency: 'USD', pricePerUnit: '0.60', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini', metricKey: 'cached_input_tokens', currency: 'USD', pricePerUnit: '0.06', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini', metricKey: 'output_text_tokens', currency: 'USD', pricePerUnit: '2.40', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini', metricKey: 'input_audio_tokens', currency: 'USD', pricePerUnit: '10.00', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini', metricKey: 'cached_input_audio_tokens', currency: 'USD', pricePerUnit: '0.30', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
  { provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini', metricKey: 'output_audio_tokens', currency: 'USD', pricePerUnit: '20.00', unitSize: '1000000', validFrom: '2026-07-17T00:00:00.000Z', validUntil: null },
];

function realtimeEvent(overrides: Partial<UsageEventForCosting> = {}): UsageEventForCosting {
  return makeEvent({ service: 'realtime', model: 'gpt-realtime-2.1-mini', ...overrides });
}

describe('Realtime audio tokens — split with no double charge (same rule as text)', () => {
  it('splits input_audio_tokens into regular + cached, pricing each once', async () => {
    const outcome = await calculateEventCost(
      realtimeEvent(),
      [
        metric('m-audio-in', 'input_audio_tokens', 1000), // total, includes cached
        metric('m-audio-cached', 'cached_input_audio_tokens', 300),
      ],
      makeFakePricingRepository(GPT_REALTIME_MINI_PRICES),
      noopLogger,
    );
    const audioIn = outcome.metricResults.find((m) => m.metricKey === 'input_audio_tokens')!;
    const audioCached = outcome.metricResults.find((m) => m.metricKey === 'cached_input_audio_tokens')!;

    expect(audioIn.billableQuantity).toBe(700); // 1000 - 300, never the full 1000
    expect(audioCached.billableQuantity).toBe(300);
    expect(audioIn.calculatedCostUsd).toBe(calculateLineCostUsd(700, '10.00', '1000000'));
    expect(audioCached.calculatedCostUsd).toBe(calculateLineCostUsd(300, '0.30', '1000000'));
  });

  it('caps billed audio cache at the input total when cache exceeds input (anomalous), logs one anomaly', async () => {
    const anomalies: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const outcome = await calculateEventCost(
      realtimeEvent(),
      [
        metric('m-audio-in', 'input_audio_tokens', 50),
        metric('m-audio-cached', 'cached_input_audio_tokens', 400),
      ],
      makeFakePricingRepository(GPT_REALTIME_MINI_PRICES),
      (event, data) => anomalies.push({ event, data }),
    );
    const audioIn = outcome.metricResults.find((m) => m.metricKey === 'input_audio_tokens')!;
    const audioCached = outcome.metricResults.find((m) => m.metricKey === 'cached_input_audio_tokens')!;

    expect(audioIn.billableQuantity).toBe(0);
    expect(audioCached.billableQuantity).toBe(50); // capped, not 400
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].data?.metricKey).toBe('input_audio_tokens');
    expect(anomalies[0].data?.type).toBe('cached_exceeds_input');
  });

  it('text and audio cache splits are independent — one anomalous, the other not', async () => {
    const anomalies: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const outcome = await calculateEventCost(
      realtimeEvent(),
      [
        metric('m-text-in', 'input_text_tokens', 500),
        metric('m-text-cached', 'cached_input_tokens', 100), // fine, no anomaly
        metric('m-audio-in', 'input_audio_tokens', 50),
        metric('m-audio-cached', 'cached_input_audio_tokens', 400), // anomalous
      ],
      makeFakePricingRepository(GPT_REALTIME_MINI_PRICES),
      (event, data) => anomalies.push({ event, data }),
    );
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].data?.metricKey).toBe('input_audio_tokens');

    const textIn = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    expect(textIn.billableQuantity).toBe(400); // 500 - 100, unaffected by the audio anomaly
  });

  it('tokens in cache are never billed twice as regular tokens (text and audio both)', async () => {
    const outcome = await calculateEventCost(
      realtimeEvent(),
      [
        metric('m-text-in', 'input_text_tokens', 1000),
        metric('m-text-cached', 'cached_input_tokens', 1000), // fully cached
        metric('m-audio-in', 'input_audio_tokens', 2000),
        metric('m-audio-cached', 'cached_input_audio_tokens', 2000), // fully cached
      ],
      makeFakePricingRepository(GPT_REALTIME_MINI_PRICES),
      noopLogger,
    );
    const textIn = outcome.metricResults.find((m) => m.metricKey === 'input_text_tokens')!;
    const audioIn = outcome.metricResults.find((m) => m.metricKey === 'input_audio_tokens')!;
    expect(textIn.billableQuantity).toBe(0);
    expect(textIn.calculatedCostUsd).toBe('0');
    expect(audioIn.billableQuantity).toBe(0);
    expect(audioIn.calculatedCostUsd).toBe('0');
  });

  it('full six-metric Realtime event totals the sum of all six independently priced lines', async () => {
    const outcome = await calculateEventCost(
      realtimeEvent(),
      [
        metric('m-text-in', 'input_text_tokens', 1000),
        metric('m-text-cached', 'cached_input_tokens', 200),
        metric('m-text-out', 'output_text_tokens', 300),
        metric('m-audio-in', 'input_audio_tokens', 5000),
        metric('m-audio-cached', 'cached_input_audio_tokens', 1000),
        metric('m-audio-out', 'output_audio_tokens', 4000),
        metric('m-requests', 'provider_requests', 1, false),
      ],
      makeFakePricingRepository(GPT_REALTIME_MINI_PRICES),
      noopLogger,
    );

    expect(outcome.allBillableMetricsPriced).toBe(true);
    const expectedTotal = sumDecimalStrings([
      calculateLineCostUsd(800, '0.60', '1000000'),    // text in, minus cached
      calculateLineCostUsd(200, '0.06', '1000000'),    // cached text in
      calculateLineCostUsd(300, '2.40', '1000000'),    // text out
      calculateLineCostUsd(4000, '10.00', '1000000'),  // audio in, minus cached
      calculateLineCostUsd(1000, '0.30', '1000000'),   // cached audio in
      calculateLineCostUsd(4000, '20.00', '1000000'),  // audio out
    ]);
    expect(outcome.totalCostUsd).toBe(expectedTotal);
  });

  it('recalculating the same Realtime event twice is idempotent (no accumulation)', async () => {
    const metrics = [
      metric('m-text-in', 'input_text_tokens', 1000),
      metric('m-text-cached', 'cached_input_tokens', 200),
      metric('m-audio-in', 'input_audio_tokens', 5000),
      metric('m-audio-cached', 'cached_input_audio_tokens', 1000),
    ];
    const repo = makeFakePricingRepository(GPT_REALTIME_MINI_PRICES);
    const first = await calculateEventCost(realtimeEvent(), metrics, repo, noopLogger);
    const second = await calculateEventCost(realtimeEvent(), metrics, repo, noopLogger);
    expect(second.totalCostUsd).toBe(first.totalCostUsd);
  });
});
