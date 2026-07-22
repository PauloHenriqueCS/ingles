/**
 * Integration tests for api/pronunciation-training/[...slug].ts (generate-text) —
 * AI Gateway integration (Etapa 8D).
 *
 * Scope: only the physical openai.chat.completions.create(...) call is wrapped.
 * Auth, level lookup, validation, and response shape are unaffected — this file
 * only asserts gateway behavior (feature_key pronunciation.generate_text).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps, aiOk } from './_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockCreate, mockRequireAuth, mockGetCurrentUserPlanEntitlements, gw } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockGetCurrentUserPlanEntitlements = vi.fn();
  return { mockCreate, mockRequireAuth, mockGetCurrentUserPlanEntitlements, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_azure-speech', () => ({
  issueAzureSpeechToken: vi.fn(),
  AzureSpeechError: class AzureSpeechError extends Error {},
}));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

import handler from '../pronunciation-training/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000002';

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      // The daily get-or-create lookup (pronunciation_training_sessions) —
      // no existing session by default, so every test below still exercises
      // the AI-generation path unless it overrides this explicitly.
      if (table === 'pronunciation_training_sessions') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      // english_learning_memory (current CEFR level lookup)
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { current_level: 'B1' } }),
      };
    }),
    rpc: vi.fn().mockResolvedValue({
      data: { sessionId: 'session-1', text: 'A short pronunciation practice text.', level: 'B1', status: 'text_generated', result: null },
      error: null,
    }),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/pronunciation-training/generate-text',
    headers: { authorization: 'Bearer test-token' },
    body: {},
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader: vi.fn(),
  };
  return res;
}

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Number.POSITIVE_INFINITY, period, state: 'unlimited', canStart: true };
}

function permissiveEntitlements(): PlanEntitlementsSnapshot {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: { enabled: true, evaluations: permissiveLimit('day'), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockCreate.mockImplementation(() => aiOk('A short pronunciation practice text.'));
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSupabase() });
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  process.env.OPENAI_API_KEY = 'test-key';
});

describe('plan entitlements gate', () => {
  it('blocks with FEATURE_DISABLED when pronunciation.enabled is false, before calling OpenAI', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.pronunciation.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('LEGACY mode', () => {
  it('returns the generated text and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).text).toBeTruthy();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
    expect(gw.mockInsertMetrics).not.toHaveBeenCalled();
  });
});

describe('OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event for the single physical call', async () => {
    await handler(makeReq(), makeRes());
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockFailEvent).not.toHaveBeenCalled();
  });

  it('uses featureKey pronunciation.generate_text with userId from auth, attemptNumber 1', async () => {
    await handler(makeReq({ body: { userId: 'injected-evil' } }), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'pronunciation.generate_text',
        provider: 'openai',
        service: 'chat.completions',
        model: 'gpt-4o-mini',
        userId: USER_ID,
        initiatedByUserId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
        callSequence: 1,
      }),
    );
  });

  it('records input/output tokens and a non-billable provider_requests metric', async () => {
    mockCreate.mockImplementation(() => aiOk('Text.', { prompt_tokens: 42, completion_tokens: 17 }));
    await handler(makeReq(), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 42, isBillable: true }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 17, isBillable: true }));
  });

  it('records cached_input_tokens only when present and > 0', async () => {
    mockCreate.mockImplementation(() => aiOk('Text.', {
      prompt_tokens: 42, completion_tokens: 17,
      prompt_tokens_details: { cached_tokens: 10 },
    }));
    await handler(makeReq(), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'cached_input_tokens', quantity: 10, isBillable: true }));
  });

  it('does not record cached_input_tokens when zero', async () => {
    mockCreate.mockImplementation(() => aiOk('Text.', {
      prompt_tokens: 42, completion_tokens: 17,
      prompt_tokens_details: { cached_tokens: 0 },
    }));
    await handler(makeReq(), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics.some((m) => m.metricKey === 'cached_input_tokens')).toBe(false);
  });

  it('provider error creates a failed event and preserves the previous 503 response', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(503);
  });

  it('metadata contains no prompt/level content, only allowlisted technical fields', async () => {
    await handler(makeReq(), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    expect(Object.keys(startCall.metadata).sort()).toEqual(['endpoint', 'flowType'].sort());
    const metadataStr = JSON.stringify(startCall.metadata);
    expect(metadataStr).not.toContain('B1');
  });

  it('a telemetry failure (startEvent) does not break the response', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
  });

  it('a metrics-insert failure does not break the response', async () => {
    gw.mockInsertMetrics.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
  });

  it('a daily-rollup failure does not break the response', async () => {
    gw.mockRebuildBucketForEvent.mockRejectedValue(new Error('lock timeout'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
  });
});

describe('unauthenticated request', () => {
  it('never reaches OpenAI or telemetry', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});
