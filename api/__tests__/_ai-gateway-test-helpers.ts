/**
 * Shared mock-deps factory for AI Gateway integration tests (Etapa 8D).
 *
 * Mirrors the shape used by review-text-gateway.test.ts / compare-rewrite-gateway.test.ts /
 * generate-theme-gateway.test.ts so every feature's gateway test exercises the real
 * executeAiGatewayCall with injected mock deps — no real DB or OpenAI calls.
 */

import { vi } from 'vitest';

export function createMockGatewayDeps() {
  const mockStartEvent = vi.fn();
  const mockCompleteEvent = vi.fn();
  const mockFailEvent = vi.fn();
  const mockInsertMetrics = vi.fn();
  const mockGetEventForCosting = vi.fn();
  const mockGetMetricsForEvent = vi.fn();
  const mockUpdateMetricCost = vi.fn();
  const mockUpdateEventCost = vi.fn();
  const mockFindActivePrice = vi.fn();
  const mockRebuildBucketForEvent = vi.fn();
  const mockRebuildBucket = vi.fn();
  const mockListBucketsForDate = vi.fn();
  const mockPolicyResolvePolicy = vi.fn();
  const mockClock = vi.fn(() => 1000);
  const mockUuidGen = vi.fn(() => 'test-uuid');
  const mockLogger = vi.fn();

  const mockDeps = {
    policyResolver: { resolvePolicy: mockPolicyResolvePolicy, invalidate: vi.fn() },
    usageRepository: {
      startEvent: mockStartEvent,
      completeEvent: mockCompleteEvent,
      failEvent: mockFailEvent,
      cancelEvent: vi.fn(),
      insertMetrics: mockInsertMetrics,
      createProviderSession: vi.fn(),
      activateSession: vi.fn(),
      completeSession: vi.fn(),
      failSession: vi.fn(),
      expireSession: vi.fn(),
      getEventForCosting: mockGetEventForCosting,
      getMetricsForEvent: mockGetMetricsForEvent,
      updateMetricCost: mockUpdateMetricCost,
      updateEventCost: mockUpdateEventCost,
    },
    pricingRepository: {
      findActivePrice: mockFindActivePrice,
    },
    dailyRollupRepository: {
      rebuildBucketForEvent: mockRebuildBucketForEvent,
      rebuildBucket: mockRebuildBucket,
      listBucketsForDate: mockListBucketsForDate,
    },
    clock: mockClock,
    uuidGen: mockUuidGen,
    logger: mockLogger,
  };

  function resetDefaults() {
    let eventCounter = 0;
    let uuidCounter = 0;
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    mockStartEvent.mockImplementation(() => Promise.resolve(`event-${++eventCounter}`));
    mockCompleteEvent.mockResolvedValue(undefined);
    mockFailEvent.mockResolvedValue(undefined);
    mockInsertMetrics.mockResolvedValue(undefined);
    mockGetEventForCosting.mockResolvedValue(null);
    mockGetMetricsForEvent.mockResolvedValue([]);
    mockUpdateMetricCost.mockResolvedValue(undefined);
    mockUpdateEventCost.mockResolvedValue(undefined);
    mockFindActivePrice.mockResolvedValue(null);
    mockRebuildBucketForEvent.mockResolvedValue('daily-bucket-1');
    mockRebuildBucket.mockResolvedValue('daily-bucket-1');
    mockListBucketsForDate.mockResolvedValue([]);
    mockClock.mockReturnValue(1000);
    mockUuidGen.mockImplementation(() => `test-uuid-${++uuidCounter}`);
  }

  return {
    mockDeps,
    mockStartEvent,
    mockCompleteEvent,
    mockFailEvent,
    mockInsertMetrics,
    mockGetEventForCosting,
    mockGetMetricsForEvent,
    mockUpdateMetricCost,
    mockUpdateEventCost,
    mockFindActivePrice,
    mockRebuildBucketForEvent,
    mockRebuildBucket,
    mockListBucketsForDate,
    mockPolicyResolvePolicy,
    mockClock,
    mockUuidGen,
    mockLogger,
    resetDefaults,
  };
}

/** Standard OpenAI-shaped success response with usage. */
export function aiOk(content: string, usage?: Record<string, unknown>) {
  return Promise.resolve({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}
