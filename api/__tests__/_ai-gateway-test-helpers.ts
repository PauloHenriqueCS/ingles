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
  const mockCreateProviderSession = vi.fn();
  const mockActivateSession = vi.fn();
  const mockCompleteSession = vi.fn();
  const mockFailSession = vi.fn();
  const mockExpireSession = vi.fn();
  const mockEntitlementResolve = vi.fn();
  const mockReservationsReserve = vi.fn();
  const mockReservationsCommit = vi.fn();
  const mockReservationsRelease = vi.fn();
  const mockReservationsMarkReconciliationRequired = vi.fn();
  const mockReservationsListExpiredPending = vi.fn();
  const mockGetSessionUsageEvents = vi.fn();

  const mockDeps = {
    policyResolver: { resolvePolicy: mockPolicyResolvePolicy, invalidate: vi.fn() },
    entitlementResolver: { resolve: mockEntitlementResolve },
    reservationsRepository: {
      reserve: mockReservationsReserve,
      commit: mockReservationsCommit,
      release: mockReservationsRelease,
      markReconciliationRequired: mockReservationsMarkReconciliationRequired,
      listExpiredPending: mockReservationsListExpiredPending,
    },
    usageRepository: {
      startEvent: mockStartEvent,
      completeEvent: mockCompleteEvent,
      failEvent: mockFailEvent,
      cancelEvent: vi.fn(),
      insertMetrics: mockInsertMetrics,
      createProviderSession: mockCreateProviderSession,
      activateSession: mockActivateSession,
      completeSession: mockCompleteSession,
      failSession: mockFailSession,
      expireSession: mockExpireSession,
      getEventForCosting: mockGetEventForCosting,
      getMetricsForEvent: mockGetMetricsForEvent,
      updateMetricCost: mockUpdateMetricCost,
      updateEventCost: mockUpdateEventCost,
      getSessionUsageEvents: mockGetSessionUsageEvents,
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
    let sessionCounter = 0;
    let reservationCounter = 0;
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
    mockCreateProviderSession.mockImplementation(() => Promise.resolve(`session-${++sessionCounter}`));
    mockActivateSession.mockResolvedValue(undefined);
    mockCompleteSession.mockResolvedValue(undefined);
    mockFailSession.mockResolvedValue(undefined);
    mockExpireSession.mockResolvedValue(undefined);
    mockEntitlementResolve.mockResolvedValue({
      allowed: true, userId: null, actorType: 'user', featureKey: 'conversation.webrtc_connect',
      effectivePlanId: null, limits: [], source: 'no_plan_configured', revision: null,
      resolvedAt: new Date(0).toISOString(),
    });
    mockReservationsReserve.mockImplementation(() => Promise.resolve({
      reservationId: `reservation-${++reservationCounter}`, status: 'pending',
      expiresAt: new Date(1000).toISOString(), blockedReason: null, blockedDetail: null,
    }));
    mockReservationsCommit.mockResolvedValue(undefined);
    mockReservationsRelease.mockResolvedValue(undefined);
    mockReservationsMarkReconciliationRequired.mockResolvedValue(undefined);
    mockReservationsListExpiredPending.mockResolvedValue([]);
    mockGetSessionUsageEvents.mockResolvedValue([]);
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
    mockCreateProviderSession,
    mockActivateSession,
    mockCompleteSession,
    mockFailSession,
    mockExpireSession,
    mockEntitlementResolve,
    mockReservationsReserve,
    mockReservationsCommit,
    mockReservationsRelease,
    mockReservationsMarkReconciliationRequired,
    mockReservationsListExpiredPending,
    mockGetSessionUsageEvents,
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
