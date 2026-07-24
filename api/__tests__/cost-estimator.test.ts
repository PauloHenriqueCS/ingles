/**
 * Unit tests for api/_ai-gateway/cost-estimator.ts — the centralized
 * conservative pre-call cost estimate that fixes the estimatedCostUsd-
 * always-null budget gap (see enforcement.test.ts for the wiring-level
 * proof and the SQL-side fix in
 * 20260724030000_ai_gateway_conservative_budget_estimate_fix.sql).
 */

import { describe, it, expect, vi } from 'vitest';
import { estimateConservativeCostUsd } from '../_ai-gateway/cost-estimator';
import type { PricingRepositoryInterface, PriceLookupResult } from '../_ai-gateway/pricing-repository';

function makePricing(price: PriceLookupResult | null): PricingRepositoryInterface {
  return { findActivePrice: vi.fn().mockResolvedValue(price) };
}

const NOW = new Date('2026-07-24T00:00:00Z');

describe('estimateConservativeCostUsd', () => {
  it('provider_requests alone (the universal non-billable metric) resolves to a real $0, never unresolved', async () => {
    const pricing = makePricing(null); // no price row exists for provider_requests, by design
    const outcome = await estimateConservativeCostUsd(
      { provider: 'openai', service: 'chat', model: 'gpt-4o-mini', metrics: [{ metricKey: 'provider_requests', quantity: 3 }] },
      pricing, NOW,
    );
    expect(outcome).toEqual({ resolved: true, totalCostUsd: '0' });
    expect(pricing.findActivePrice).not.toHaveBeenCalled(); // never priced — allowlisted as always-free
  });

  it('a single priced billable metric produces quantity × price / unitSize', async () => {
    const pricing = makePricing({ id: 'p1', pricePerUnit: '0.15', unitSize: '1000000', currency: 'USD' });
    const outcome = await estimateConservativeCostUsd(
      { provider: 'openai', service: 'chat', model: 'gpt-4o-mini', metrics: [{ metricKey: 'output_text_tokens', quantity: 4096 }] },
      pricing, NOW,
    );
    expect(outcome).toEqual({ resolved: true, totalCostUsd: '0.0006144' });
  });

  it('sums multiple priced billable metrics into one conservative total', async () => {
    const pricing: PricingRepositoryInterface = {
      findActivePrice: vi.fn().mockImplementation(async ({ metricKey }) => {
        if (metricKey === 'input_text_tokens') return { id: 'p-in', pricePerUnit: '0.15', unitSize: '1000000', currency: 'USD' };
        if (metricKey === 'output_text_tokens') return { id: 'p-out', pricePerUnit: '0.60', unitSize: '1000000', currency: 'USD' };
        return null;
      }),
    };
    const outcome = await estimateConservativeCostUsd(
      {
        provider: 'openai', service: 'chat', model: 'gpt-4o-mini',
        metrics: [
          { metricKey: 'provider_requests', quantity: 1 },
          { metricKey: 'input_text_tokens', quantity: 1_000_000 },
          { metricKey: 'output_text_tokens', quantity: 1_000_000 },
        ],
      },
      pricing, NOW,
    );
    expect(outcome).toEqual({ resolved: true, totalCostUsd: '0.75' }); // 0.15 + 0.60
  });

  it('a billable metric with NO active price makes the whole estimate unresolved — never silently $0', async () => {
    const pricing = makePricing(null);
    const outcome = await estimateConservativeCostUsd(
      { provider: 'azure', service: 'speech_sts', model: null, metrics: [{ metricKey: 'audio_seconds', quantity: 900 }] },
      pricing, NOW,
    );
    expect(outcome).toEqual({ resolved: false, unpricedMetricKey: 'audio_seconds' });
  });

  it('an unresolved metric short-circuits — later metrics are never priced once one is already unresolved', async () => {
    const findActivePrice = vi.fn().mockResolvedValue(null);
    const pricing: PricingRepositoryInterface = { findActivePrice };
    await estimateConservativeCostUsd(
      {
        provider: 'openai', service: 'realtime', model: 'gpt-realtime-2.1-mini',
        metrics: [
          { metricKey: 'input_text_tokens', quantity: 100 },
          { metricKey: 'output_audio_tokens', quantity: 3000 },
        ],
      },
      pricing, NOW,
    );
    expect(findActivePrice).toHaveBeenCalledTimes(1);
  });

  it('a zero-quantity metric is skipped without a price lookup', async () => {
    const pricing = makePricing(null);
    const outcome = await estimateConservativeCostUsd(
      { provider: 'openai', service: 'chat', model: 'gpt-4o-mini', metrics: [{ metricKey: 'output_text_tokens', quantity: 0 }] },
      pricing, NOW,
    );
    expect(outcome).toEqual({ resolved: true, totalCostUsd: '0' });
    expect(pricing.findActivePrice).not.toHaveBeenCalled();
  });

  it('an empty metrics array resolves to $0', async () => {
    const pricing = makePricing(null);
    const outcome = await estimateConservativeCostUsd({ provider: 'openai', metrics: [] }, pricing, NOW);
    expect(outcome).toEqual({ resolved: true, totalCostUsd: '0' });
  });

  it('passes provider/service/model/currency/at through to findActivePrice exactly as given', async () => {
    const findActivePrice = vi.fn().mockResolvedValue({ id: 'p1', pricePerUnit: '1', unitSize: '1', currency: 'USD' });
    const pricing: PricingRepositoryInterface = { findActivePrice };
    await estimateConservativeCostUsd(
      { provider: 'azure', service: 'speech_sts', model: null, metrics: [{ metricKey: 'audio_seconds', quantity: 10 }] },
      pricing, NOW,
    );
    expect(findActivePrice).toHaveBeenCalledWith({
      provider: 'azure', service: 'speech_sts', model: null, metricKey: 'audio_seconds', currency: 'USD', at: NOW,
    });
  });
});
