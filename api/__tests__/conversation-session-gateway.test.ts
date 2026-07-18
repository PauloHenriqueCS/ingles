/**
 * Integration tests for api/conversation/[...slug].ts — AI Gateway
 * integration (Etapa 10):
 *   - conversation.create_session: backend-wrapped client_secrets call, plus
 *     the ai_provider_sessions bridge authorized for conversation.webrtc_connect.
 *   - conversation.webrtc_connect: session-active, session-failed, session-end
 *     — the authenticated bridge the browser reports connection outcome to.
 *   - conversation.realtime_usage: session-usage — idempotent per-response
 *     token relay, deduplicated by (provider_session_record_id, providerRequestId).
 *
 * Routes are flat, single-segment slugs (session-active, not session/active):
 * the nested shape 404'd in production — Vercel never routed the extra path
 * segment into this function at all. See the "dispatcher — Vercel-shaped..."
 * describe block below for the routing-contract proof.
 *
 * Scope: requireAuth and the existing /session pedagogical response shape
 * (instructions, prefs, etc.) are unaffected — this file only asserts
 * Gateway/session behavior layered additively on top.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetCurrentUserPlanEntitlements, gw } = vi.hoisted(() => {
  const mockRequireAuth = vi.fn();
  const mockGetCurrentUserPlanEntitlements = vi.fn();
  return { mockRequireAuth, mockGetCurrentUserPlanEntitlements, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

// Separate mock Supabase client standing in for getSharedServiceClient() —
// used only by the session-transition bridge code (session-active, -failed,
// -usage, -end), distinct from the per-request `supabase` (requireAuth) used
// by the existing /session pedagogical-context queries.
const { mockSessionsFrom, sessionsClient } = vi.hoisted(() => {
  const mockSessionsFrom = vi.fn();
  return { mockSessionsFrom, sessionsClient: { from: mockSessionsFrom } };
});

function makeUpdateChain(result: { data: { id: string; started_at?: string | null } | null; error: unknown }) {
  const chain: any = {};
  for (const m of ['update', 'eq', 'in', 'or', 'select']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}
function makeSelectChain(result: { data: Record<string, unknown> | null; error: unknown }) {
  const chain: any = {};
  for (const m of ['select', 'eq']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps, getSharedServiceClient: () => sessionsClient };
});

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

import handler from '../conversation/[...slug]';
import { DuplicateUsageEventError } from '../_ai-gateway/usage-repository';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000031';
const OTHER_USER_ID = 'bbbbbbbb-0000-0000-0000-000000000032';
const GATEWAY_SESSION_ID = 'cccccccc-0000-0000-0000-000000000001';

function makeSessionSupabase() {
  const chain: any = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null });
  chain.then = (resolve: (v: { data: unknown }) => void) => resolve({ data: [] });
  return { from: vi.fn().mockReturnValue(chain) };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', url: '/api/conversation/session', headers: { authorization: 'Bearer test-token' }, body: {}, ...overrides };
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

function mockClientSecretsFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'req-id-123' },
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
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
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSessionSupabase() });
  mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null }));
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  process.env.OPENAI_API_KEY = 'sk-test-key';
  process.env.OPENAI_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
});

// ── conversation.create_session ─────────────────────────────────────────────

describe('POST /session — conversation.create_session', () => {
  const GA_RESPONSE = { value: 'ephemeral-token-xyz', expires_at: 9999999999, session: { id: 'sess-123', model: 'gpt-realtime-2.1-mini' } };

  it('LEGACY: issues the token, writes no telemetry, no gatewaySessionId in response', async () => {
    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('ephemeral-token-xyz');
    expect((res._body() as any).gatewaySessionId).toBeUndefined();
    // Fase 9 — always present, independent of gatewaySessionId/observe mode,
    // so the client can source its self-termination timer from the server.
    expect((res._body() as any).maxSessionSeconds).toBe(30 * 60);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  // ── Fase 12: authorized max recording seconds ─────────────────────────────

  it('scenario 25: both per-turn and monthly unlimited — authorized max is governed only by the technical ceiling', async () => {
    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body() as { authorizedMaxRecordingSeconds: number; recordingLimitReason: string };
    expect(body.recordingLimitReason).toBe('technical');
    expect(body.authorizedMaxRecordingSeconds).toBeCloseTo(30 * 60, 0);
  });

  it('scenario 24: monthly unlimited + finite per-turn cap — authorized max is governed by the per-turn cap', async () => {
    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const entitlements = permissiveEntitlements();
    entitlements.conversation.maxRecordingSeconds = 45;
    entitlements.conversation.maxRecordingUnlimited = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body() as { authorizedMaxRecordingSeconds: number; recordingLimitReason: string };
    expect(body.recordingLimitReason).toBe('per_turn');
    expect(body.authorizedMaxRecordingSeconds).toBeCloseTo(45, 0);
  });

  it('scenario 23: per-turn unlimited + finite monthly balance — authorized max is governed by the remaining monthly balance', async () => {
    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const entitlements = permissiveEntitlements();
    entitlements.conversation.monthlyTime = {
      enabled: true, unlimited: false, limit: 600, consumed: 580, remaining: 20, period: 'month', state: 'available', canStart: true,
    };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body() as { authorizedMaxRecordingSeconds: number; recordingLimitReason: string };
    expect(body.recordingLimitReason).toBe('monthly_balance');
    expect(body.authorizedMaxRecordingSeconds).toBeCloseTo(20, 0);
  });

  it('returns 403 FEATURE_DISABLED and never calls OpenAI when conversation is disabled by plan', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.conversation.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect((global.fetch as any)).not.toHaveBeenCalled();
  });

  it('returns 403 MONTHLY_LIMIT_REACHED and never calls OpenAI once the monthly balance (plan + extra credits) is exhausted', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.conversation.monthlyTime = {
      enabled: true, unlimited: false, limit: 600, consumed: 600, remaining: 0, period: 'month', state: 'monthly_limit_reached', canStart: false,
    };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('MONTHLY_LIMIT_REACHED');
    expect((global.fetch as any)).not.toHaveBeenCalled();
  });

  it('allows session creation through when monthly balance is exhausted but extra credits keep canStart true', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.conversation.monthlyTime = {
      enabled: true, unlimited: false, limit: 600, consumed: 600, remaining: 200, period: 'month', state: 'available_with_extra_credits', canStart: true,
    };
    entitlements.conversation.extraSecondsAvailable = 200;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
  });

  describe('OBSERVE for create_session only (webrtc_connect stays legacy)', () => {
    beforeEach(() => {
      gw.mockPolicyResolvePolicy.mockImplementation(async (ctx: any) =>
        ctx.featureKey === 'conversation.create_session'
          ? { gatewayMode: 'observe', runtimeStatus: 'enabled' }
          : { gatewayMode: 'legacy', runtimeStatus: 'enabled' },
      );
    });

    it('records one event, provider_requests=1, not billable, no session authorized', async () => {
      vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
      const res = makeRes();
      await handler(makeReq(), res);
      expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
      expect(gw.mockStartEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          featureKey: 'conversation.create_session',
          provider: 'openai',
          service: 'realtime.client_secrets',
          model: 'gpt-realtime-2.1-mini',
          userId: USER_ID,
        }),
      );
      const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(metrics).toEqual([expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false })]);
      expect((res._body() as any).gatewaySessionId).toBeUndefined();
    });
  });

  describe('OBSERVE for both create_session and webrtc_connect', () => {
    beforeEach(() => {
      gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    });

    it('authorizes an ai_provider_sessions row for feature_key conversation.webrtc_connect and returns gatewaySessionId', async () => {
      vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).token).toBe('ephemeral-token-xyz'); // existing field unchanged
      expect((res._body() as any).gatewaySessionId).toBeTruthy();
      expect(gw.mockDeps.usageRepository.createProviderSession).toHaveBeenCalledWith(
        expect.objectContaining({ featureKey: 'conversation.webrtc_connect', provider: 'openai', userId: USER_ID }),
      );
    });

    it('never persists the ephemeral token — only its SHA-256 fingerprint', async () => {
      vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
      await handler(makeReq(), makeRes());
      const call = (gw.mockDeps.usageRepository.createProviderSession as any).mock.calls[0][0];
      expect(call.authorizationFingerprint).not.toBe('ephemeral-token-xyz');
      expect(call.authorizationFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(call)).not.toContain('ephemeral-token-xyz');
    });

    it('a session-authorization failure never blocks token issuance (fail-open)', async () => {
      (gw.mockDeps.usageRepository.createProviderSession as any).mockRejectedValue(new Error('db down'));
      vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).token).toBe('ephemeral-token-xyz');
      expect((res._body() as any).gatewaySessionId).toBeUndefined();
    });

    it('an OpenAI HTTP error still creates a failed event and preserves the previous error mapping', async () => {
      vi.stubGlobal('fetch', mockClientSecretsFetch(429, { error: { type: 'rate_limit' } }));
      const res = makeRes();
      await handler(makeReq(), res);
      expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
      expect(res._status()).toBe(429);
      expect((res._body() as any).code).toBe('OPENAI_RATE_LIMITED');
    });

    it('a telemetry failure never prevents the pedagogical /session response', async () => {
      gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
      vi.stubGlobal('fetch', mockClientSecretsFetch(200, GA_RESPONSE));
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).token).toBe('ephemeral-token-xyz');
    });
  });
});

// ── conversation.webrtc_connect — session-active ───────────────────────────

describe('POST /session-active — conversation.webrtc_connect', () => {
  function activeReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID }) {
    return makeReq({ url: '/api/conversation/session-active', body });
  }

  it('activates the session and records one succeeded event, provider_requests only, not billable', async () => {
    const res = makeRes();
    await handler(activeReq(), res);
    expect(res._status()).toBe(200);

    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.eq).toHaveBeenCalledWith('user_id', USER_ID);
    expect(chain.eq).toHaveBeenCalledWith('feature_key', 'conversation.webrtc_connect');
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));

    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'conversation.webrtc_connect',
        provider: 'openai',
        userId: USER_ID,
        isBillable: false,
        callSequence: 1,
        providerSessionRecordId: GATEWAY_SESSION_ID,
      }),
    );
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toEqual([expect.objectContaining({ metricKey: 'provider_requests', isBillable: false, measurementSource: 'client_provider_call_reported' })]);
  });

  it('a session belonging to another user is a no-op — no event, 200 response', async () => {
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    const res = makeRes();
    await handler(activeReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('an already-active or terminal session cannot be reactivated — idempotent no-op (WHERE status IN clause excludes it)', async () => {
    // The atomic UPDATE...WHERE status IN ('authorized','connecting') matches
    // nothing once already active/terminal — same no-op path as ownership mismatch.
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    await handler(activeReq(), makeRes());
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid gatewaySessionId before touching the database', async () => {
    const res = makeRes();
    await handler(activeReq({ gatewaySessionId: 'not-a-uuid' }), res);
    expect(res._status()).toBe(400);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('a telemetry failure never surfaces as an error to the browser (fail-open)', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handler(activeReq(), res);
    expect(res._status()).toBe(200);
  });

  it('persists a valid captured callId as provider_session_id in the same atomic update', async () => {
    const res = makeRes();
    await handler(activeReq({ gatewaySessionId: GATEWAY_SESSION_ID, callId: 'call_captured_abc123' }), res);
    expect(res._status()).toBe(200);
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ provider_session_id: 'call_captured_abc123' }));
  });

  it('never persists a malformed callId (allowlist-rejected, e.g. containing unexpected characters)', async () => {
    const res = makeRes();
    await handler(activeReq({ gatewaySessionId: GATEWAY_SESSION_ID, callId: 'not valid! id/../etc' }), res);
    expect(res._status()).toBe(200);
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.not.objectContaining({ provider_session_id: expect.anything() }));
  });

  it('omits provider_session_id from the update entirely when no callId was reported (the normal, CORS-degraded case)', async () => {
    const res = makeRes();
    await handler(activeReq(), res);
    expect(res._status()).toBe(200);
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.not.objectContaining({ provider_session_id: expect.anything() }));
  });
});

// ── conversation.webrtc_connect — session-failed ───────────────────────────

describe('POST /session-failed — conversation.webrtc_connect', () => {
  function failedReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID, reason: 'webrtc_failed' }) {
    return makeReq({ url: '/api/conversation/session-failed', body });
  }

  it('fails the session and records one failed event with the reported reason', async () => {
    const res = makeRes();
    await handler(failedReq(), res);
    expect(res._status()).toBe(200);
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(gw.mockFailEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorCode: 'webrtc_failed', errorCategory: 'client_reported' }),
    );
  });

  it('an unrecognized reason string is normalized to "unknown", never passed through raw', async () => {
    await handler(failedReq({ gatewaySessionId: GATEWAY_SESSION_ID, reason: 'literally anything the client wants' }), makeRes());
    expect(gw.mockFailEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ errorCode: 'unknown' }));
  });

  it('an already-active session is never downgraded to failed by a stale report', async () => {
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    const res = makeRes();
    await handler(failedReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

// ── conversation.realtime_usage — session-usage ────────────────────────────

const FULL_USAGE = {
  input_token_details: { text_tokens: 100, audio_tokens: 5000, cached_tokens_details: { text_tokens: 20, audio_tokens: 1000 } },
  output_token_details: { text_tokens: 50, audio_tokens: 3000 },
};

function usageReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_abc123', usage: FULL_USAGE }) {
  return makeReq({ url: '/api/conversation/session-usage', body });
}

describe('POST /session-usage — conversation.realtime_usage', () => {
  beforeEach(() => {
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, metadata: { model: 'gpt-realtime-2.1-mini' } }, error: null }));
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records one event for conversation.realtime_usage, provider openai, service realtime, model from the session (not the client)', async () => {
    const res = makeRes();
    await handler(usageReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'conversation.realtime_usage',
        provider: 'openai',
        service: 'realtime',
        model: 'gpt-realtime-2.1-mini',
        providerSessionRecordId: GATEWAY_SESSION_ID,
        providerRequestId: 'resp_abc123',
        isBillable: true,
      }),
    );
  });

  it('persists provider_request_id = response.id — completeEvent() re-supplies it so it is never wiped back to NULL', async () => {
    // This is the exact regression: completeEvent()'s UPDATE writes
    // provider_request_id unconditionally from what it's given. Passing
    // only { latencyMs } here silently overwrote the value startEvent()
    // had just inserted, leaving every conversation.realtime_usage event's
    // provider_request_id NULL in production despite startEvent() being
    // called correctly.
    await handler(usageReq(), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'resp_abc123' }));
    expect(gw.mockCompleteEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ providerRequestId: 'resp_abc123' }),
    );
  });

  it('two different response.id values produce two distinct events, each carrying its own provider_request_id', async () => {
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_test_123', usage: FULL_USAGE }), makeRes());
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_test_456', usage: FULL_USAGE }), makeRes());

    expect(gw.mockStartEvent).toHaveBeenCalledTimes(2);
    expect(gw.mockStartEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ providerRequestId: 'resp_test_123' }));
    expect(gw.mockStartEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ providerRequestId: 'resp_test_456' }));
    expect(gw.mockCompleteEvent).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ providerRequestId: 'resp_test_123' }));
    expect(gw.mockCompleteEvent).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ providerRequestId: 'resp_test_456' }));
  });

  it('repeating resp_test_123 is idempotent — one event, one cost, no re-inserted metrics on the retry', async () => {
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_test_123', usage: FULL_USAGE }), makeRes());
    expect(gw.mockInsertMetrics).toHaveBeenCalledTimes(1);

    // Simulate the real unique-index collision the repository would raise
    // on a second insert for the same (session, response.id) pair.
    gw.mockStartEvent.mockRejectedValueOnce(new DuplicateUsageEventError());
    const res = makeRes();
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_test_123', usage: FULL_USAGE }), res);

    expect((res._body() as any).status).toBe('duplicate_ignored');
    expect(gw.mockInsertMetrics).toHaveBeenCalledTimes(1); // unchanged — no second metric write, no second cost
  });

  it('accounting_child: across several distinct response.done events, no quota/budget reservation or entitlement resolution is ever triggered — each is recorded straight through usageRepository, inheriting the parent webrtc_connect session\'s protection instead of re-reserving independently', async () => {
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_multi_1', usage: FULL_USAGE }), makeRes());
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_multi_2', usage: FULL_USAGE }), makeRes());
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_multi_3', usage: FULL_USAGE }), makeRes());

    // Three genuinely distinct responses → three accounting events (correct,
    // expected — each response really did consume new tokens)...
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(3);
    // ...but never a fourth call to the entitlement resolver (only
    // executeAiGatewayCall's enforce-mode pipeline calls it — this handler
    // never invokes executeAiGatewayCall at all), and never any reservation
    // mock, proving no independent reservation is ever attempted no matter
    // how many response.done events arrive for the same session.
    expect(gw.mockEntitlementResolve).not.toHaveBeenCalled();
  });

  it('a realistic response.done fixture (event.response.id / event.response.usage) relays correctly end to end', async () => {
    // Mirrors exactly what useRealtimeSession.ts extracts from the data
    // channel: const ev = { type: 'response.done', response: { id, usage } }.
    const fixture = { type: 'response.done', response: { id: 'resp_test_123', usage: FULL_USAGE } };
    await handler(
      usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: fixture.response.id, usage: fixture.response.usage }),
      makeRes(),
    );
    expect(gw.mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ providerRequestId: 'resp_test_123' }));
  });

  it('response.done without a response.id is never a billable event — rejected before any event is created', async () => {
    const res = makeRes();
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: undefined, usage: FULL_USAGE } as any), res);
    expect(res._status()).toBe(400);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('splits text and audio tokens into separate, correctly-valued metrics; cached tokens are separate from regular', async () => {
    await handler(usageReq(), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 100 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'cached_input_tokens', quantity: 20 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_audio_tokens', quantity: 5000 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'cached_input_audio_tokens', quantity: 1000 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 50 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_audio_tokens', quantity: 3000 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
    // Every relayed metric uses the correct measurement source.
    for (const m of metrics) expect(m.measurementSource).toBe('provider_event_client_relayed');
  });

  it('missing token detail fields default to 0, never NaN or undefined', async () => {
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_partial', usage: { input_token_details: { text_tokens: 7 } } }), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_audio_tokens', quantity: 0 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 0 }));
  });

  it('a duplicate providerResponseId for the same session is idempotent — no duplicate metrics inserted', async () => {
    gw.mockStartEvent.mockRejectedValueOnce(new DuplicateUsageEventError());
    const res = makeRes();
    await handler(usageReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('duplicate_ignored');
    expect(gw.mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('a session that is not currently active (never activated, expired, already ended) rejects usage — idempotent no-op', async () => {
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: null, error: null }));
    const res = makeRes();
    await handler(usageReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('ignored');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('conversation.realtime_usage has its own runtime policy — session existing is not sufficient alone', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const res = makeRes();
    await handler(usageReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('never creates its own reservation — accounting_child: even in enforce mode, this handler only ever records through the parent session\'s already-reserved usageRepository path (startEvent/insertMetrics), never a second executeAiGatewayCall/reservation for the same response.done', async () => {
    // Etapa 11 correction: conversation.realtime_usage is classified
    // accounting_child of conversation.webrtc_connect (see
    // api/_ai-gateway/enforce-readiness.ts's ACCOUNTING_CHILD_PARENT) —
    // requiring it to reserve independently per response.done would
    // double-reserve the same already-reserved session. handleSessionUsage
    // structurally guarantees this today by gating on gatewayMode ===
    // 'observe' exactly: 'enforce' is not yet an independent reservation
    // path here, so no second reservation can be invented no matter what
    // policy is resolved.
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'enforce', runtimeStatus: 'enabled' });
    const res = makeRes();
    await handler(usageReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('ignored');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('rejects a malformed providerResponseId (400) before touching the database', async () => {
    const res = makeRes();
    await handler(usageReq({ gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'not valid!!', usage: FULL_USAGE }), res);
    expect(res._status()).toBe(400);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('clamps an implausibly large relayed token count rather than trusting it verbatim', async () => {
    await handler(
      usageReq({
        gatewaySessionId: GATEWAY_SESSION_ID,
        providerResponseId: 'resp_huge',
        usage: { input_token_details: { text_tokens: 999_999_999_999 } },
      }),
      makeRes(),
    );
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    const textIn = metrics.find((m) => m.metricKey === 'input_text_tokens') as Record<string, unknown>;
    expect(textIn.quantity as number).toBeLessThan(999_999_999_999);
  });

  it('a telemetry failure never surfaces as an error to the browser (fail-open)', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handler(usageReq(), res);
    expect(res._status()).toBe(200);
  });

  it('never persists transcript, prompt, or SDP in metadata — only technical fields', async () => {
    await handler(usageReq(), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    expect(JSON.stringify(startCall)).not.toMatch(/transcript|sdp/i);
  });
});

// ── conversation.webrtc_connect — session-end ──────────────────────────────
// session-end never creates a new ai_usage_event: it locates the ONE event
// session-active already created (by provider_session_record_id +
// feature_key + status='succeeded') and attaches session_seconds to it —
// computed entirely from server-controlled timestamps
// (ai_provider_sessions.started_at, through this handler's own
// gatewayDeps.clock()), never from a client-supplied duration.

describe('POST /session-end — conversation.webrtc_connect', () => {
  const ORIGINAL_EVENT_ID = 'dddddddd-0000-0000-0000-000000000001';

  function endReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID }) {
    return makeReq({ url: '/api/conversation/session-end', body });
  }

  /** Wires the three sequential sessionsClient().from(...) calls /end makes:
   *  (1) the atomic ai_provider_sessions status UPDATE (the idempotency
   *      gate — only this one is guarded by WHERE status='active');
   *  (2) the follow-up ai_provider_sessions UPDATE persisting
   *      duration_seconds + measurement_source, unconditional once (1) has
   *      already proven single ownership of this completion;
   *  (3) the ai_usage_events lookup for the original session-active event. */
  function mockEndFlow(opts: {
    startedAtIso: string | null;
    endedAtMs: number;
    updateData?: { id: string; started_at: string | null } | null;
    eventLookupData?: { id: string } | null;
  }) {
    gw.mockClock.mockReturnValue(opts.endedAtMs);
    mockSessionsFrom
      .mockReturnValueOnce(makeUpdateChain({
        data: opts.updateData !== undefined ? opts.updateData : { id: GATEWAY_SESSION_ID, started_at: opts.startedAtIso },
        error: null,
      }))
      .mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null }))
      .mockReturnValueOnce(makeSelectChain({
        data: opts.eventLookupData !== undefined ? opts.eventLookupData : { id: ORIGINAL_EVENT_ID },
        error: null,
      }));
  }

  it('completes the session and attaches session_seconds to the ORIGINAL event — never creates a new ai_usage_event', async () => {
    mockEndFlow({ startedAtIso: new Date(100_000 - 42_000).toISOString(), endedAtMs: 100_000 });
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);

    const updateChain = mockSessionsFrom.mock.results[0].value;
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    // No startEvent call — /end never fabricates a second ai_usage_event.
    expect(gw.mockStartEvent).not.toHaveBeenCalled();

    expect(gw.mockInsertMetrics).toHaveBeenCalledWith(
      ORIGINAL_EVENT_ID,
      [expect.objectContaining({
        metricKey: 'session_seconds', quantity: 42, isBillable: false, measurementSource: 'server_session_timestamps',
      })],
    );
  });

  it('atomically persists duration_seconds and measurement_source on the ai_provider_sessions row itself', async () => {
    mockEndFlow({ startedAtIso: new Date(100_000 - 42_000).toISOString(), endedAtMs: 100_000 });
    await handler(endReq(), makeRes());

    // Second sessionsClient().from('ai_provider_sessions') call — the
    // duration/measurement_source follow-up UPDATE.
    const durationUpdateChain = mockSessionsFrom.mock.results[1].value;
    expect(durationUpdateChain.update).toHaveBeenCalledWith({
      duration_seconds: 42,
      measurement_source: 'server_session_timestamps',
    });
    expect(durationUpdateChain.eq).toHaveBeenCalledWith('id', GATEWAY_SESSION_ID);
  });

  it('the session duration is persisted even when the original event cannot be found (metric skipped, session duration still saved)', async () => {
    mockEndFlow({ startedAtIso: new Date(100_000 - 42_000).toISOString(), endedAtMs: 100_000, eventLookupData: null });
    await handler(endReq(), makeRes());

    const durationUpdateChain = mockSessionsFrom.mock.results[1].value;
    expect(durationUpdateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ duration_seconds: 42, measurement_source: 'server_session_timestamps' }),
    );
    expect(gw.mockInsertMetrics).not.toHaveBeenCalled(); // no event found → metric skipped, not fabricated
  });

  it('duration is always finite and non-negative, even under an anomalous clock/timestamp', async () => {
    // endedAtMs BEFORE startedAtIso — should clamp to 0, never negative.
    mockEndFlow({ startedAtIso: new Date(500_000).toISOString(), endedAtMs: 100_000 });
    await handler(endReq(), makeRes());
    const durationUpdateChain = mockSessionsFrom.mock.results[1].value;
    expect(durationUpdateChain.update).toHaveBeenCalledWith(expect.objectContaining({ duration_seconds: 0 }));
  });

  it('provider_requests (from /active) and session_seconds (from /end) share the same usage_event_id', async () => {
    // /active creates the one event.
    mockSessionsFrom.mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null }));
    await handler(makeReq({ url: '/api/conversation/session-active', body: { gatewaySessionId: GATEWAY_SESSION_ID } }), makeRes());
    const activeEventId = gw.mockInsertMetrics.mock.calls[0][0] as string;

    // /end locates that SAME event id (as the real DB lookup would).
    mockEndFlow({ startedAtIso: new Date(150_000).toISOString(), endedAtMs: 200_000, eventLookupData: { id: activeEventId } });
    await handler(endReq(), makeRes());

    const endEventId = gw.mockInsertMetrics.mock.calls[1][0] as string;
    expect(endEventId).toBe(activeEventId);
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1); // exactly one event for the whole lifecycle
  });

  it('one connect + one end together produce exactly one conversation.webrtc_connect event', async () => {
    mockSessionsFrom.mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null }));
    await handler(makeReq({ url: '/api/conversation/session-active', body: { gatewaySessionId: GATEWAY_SESSION_ID } }), makeRes());

    mockEndFlow({ startedAtIso: new Date(0).toISOString(), endedAtMs: 10_000 });
    await handler(endReq(), makeRes());

    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
  });

  it('duration is computed server-side from ai_provider_sessions.started_at, never from a client-sent value', async () => {
    // The request body carries no duration field at all — reportSessionEnd
    // (src/lib/realtimeGatewayReporting.ts) never sends one, and even if a
    // client attempted to smuggle one in, the handler never reads req.body
    // for it.
    mockEndFlow({ startedAtIso: new Date(1_000_000).toISOString(), endedAtMs: 1_007_500 }); // 7.5s later
    await handler(makeReq({ url: '/api/conversation/session-end', body: { gatewaySessionId: GATEWAY_SESSION_ID, durationSeconds: 999_999 } }), makeRes());

    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics[0].quantity).toBe(7.5); // computed value, ignoring the smuggled 999_999
    const durationUpdateChain = mockSessionsFrom.mock.results[1].value;
    expect(durationUpdateChain.update).toHaveBeenCalledWith(expect.objectContaining({ duration_seconds: 7.5 }));
  });

  it('a session that was never activated (still authorized/connecting) cannot be completed — no-op', async () => {
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('a duplicate /end call for an already-completed session is a no-op — no duplicate metric', async () => {
    mockEndFlow({ startedAtIso: new Date(0).toISOString(), endedAtMs: 5_000 });
    await handler(endReq(), makeRes());
    expect(gw.mockInsertMetrics).toHaveBeenCalledTimes(1);

    // Second call: the atomic UPDATE...WHERE status='active' now matches
    // nothing (already 'completed') — never reaches the event lookup at all.
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    await handler(endReq(), makeRes());
    expect(gw.mockInsertMetrics).toHaveBeenCalledTimes(1); // unchanged
  });

  it('does not fabricate a replacement event when the original cannot be found', async () => {
    mockEndFlow({ startedAtIso: new Date(0).toISOString(), endedAtMs: 5_000, eventLookupData: null });
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200); // session still marked completed
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
    expect(gw.mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('another user cannot end this session', async () => {
    mockRequireAuth.mockResolvedValue({ userId: OTHER_USER_ID, supabase: makeSessionSupabase() });
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockInsertMetrics).not.toHaveBeenCalled();
  });

  it('a metric-write failure is fail-open — the browser still gets 200 (session duration was already saved before this point)', async () => {
    mockEndFlow({ startedAtIso: new Date(0).toISOString(), endedAtMs: 5_000 });
    gw.mockInsertMetrics.mockRejectedValueOnce(new Error('db down'));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
  });

  it('a failure writing the session\'s own duration_seconds is fail-open — never surfaces as an error, and the metric write still proceeds', async () => {
    gw.mockClock.mockReturnValue(5_000);
    const failingDurationChain: any = { update: vi.fn(() => { throw new Error('db down'); }) };
    mockSessionsFrom
      .mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID, started_at: new Date(0).toISOString() }, error: null }))
      .mockReturnValueOnce(failingDurationChain)
      .mockReturnValueOnce(makeSelectChain({ data: { id: ORIGINAL_EVENT_ID }, error: null }));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
    // The session row itself is already marked completed regardless (call #1
    // above succeeded) — only the supplementary duration/measurement_source
    // write failed, and that failure never blocks the rest of the flow.
    expect(gw.mockInsertMetrics).toHaveBeenCalledWith(ORIGINAL_EVENT_ID, expect.any(Array));
  });

  it('rejects an invalid gatewaySessionId before touching the database', async () => {
    const res = makeRes();
    await handler(endReq({ gatewaySessionId: 'not-a-uuid' }), res);
    expect(res._status()).toBe(400);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('reconstructs the SAME daily bucket the original event belongs to (rebuild keyed by the original event id)', async () => {
    mockEndFlow({ startedAtIso: new Date(0).toISOString(), endedAtMs: 5_000, eventLookupData: { id: ORIGINAL_EVENT_ID } });
    await handler(endReq(), makeRes());
    expect(gw.mockRebuildBucketForEvent).toHaveBeenCalledWith(ORIGINAL_EVENT_ID);
  });
});

describe('duration starts at session-active, never at token issuance', () => {
  it('session-active writes ai_provider_sessions.started_at — /session (create_session) never does', async () => {
    mockSessionsFrom.mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null }));
    await handler(makeReq({ url: '/api/conversation/session-active', body: { gatewaySessionId: GATEWAY_SESSION_ID } }), makeRes());
    const updateChain = mockSessionsFrom.mock.results[0].value;
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ started_at: expect.any(String) }));
  });
});

// ── conversation.webrtc_connect — session-control (Etapa 11, Fase 9) ───────

describe('POST /session-control — mid-session control poll', () => {
  function controlReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID }) {
    return makeReq({ url: '/api/conversation/session-control', body });
  }

  it('rejects an invalid gatewaySessionId before touching the database', async () => {
    const res = makeRes();
    await handler(controlReq({ gatewaySessionId: 'not-a-uuid' }), res);
    expect(res._status()).toBe(400);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('signals terminate when the session is not active (foreign, never started, or already ended)', async () => {
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: null, error: null }));
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ terminate: true, reason: 'session_not_active' });
  });

  it('signals terminate once the server-authorized deadline has passed', async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago > the 30min ceiling
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: longAgo }, error: null }));
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ terminate: true, reason: 'max_duration_reached' });
  });

  it('signals terminate when the kill-switch is engaged for conversation.webrtc_connect', async () => {
    const now = new Date().toISOString();
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now }, error: null }));
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'disabled' });
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ terminate: true, reason: 'kill_switch' });
  });

  // ── Real server-side hangup (Etapa 11 correction §6) ─────────────────────

  describe('server-side hangup when a provider_session_id (call_id) was captured', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
    });

    it('calls OpenAI hangup with the real API key on max_duration_reached, before responding terminate:true', async () => {
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: longAgo, provider_session_id: 'call_abc123' }, error: null }));
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const res = makeRes();
      await handler(controlReq(), res);

      expect(res._status()).toBe(200);
      expect(res._body()).toEqual({ terminate: true, reason: 'max_duration_reached' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/realtime/calls/call_abc123/hangup',
        expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer sk-test-key' }) }),
      );
    });

    it('calls hangup on kill_switch termination too', async () => {
      const now = new Date().toISOString();
      mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now, provider_session_id: 'call_xyz' }, error: null }));
      gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'disabled' });
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await handler(controlReq(), makeRes());

      expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls/call_xyz/hangup', expect.anything());
    });

    it('never calls hangup when no provider_session_id was captured for the session', async () => {
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: longAgo, provider_session_id: null }, error: null }));
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const res = makeRes();
      await handler(controlReq(), res);

      expect(res._status()).toBe(200);
      expect(res._body()).toEqual({ terminate: true, reason: 'max_duration_reached' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a hangup failure never blocks the terminate response — the client still closes its own connection', async () => {
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: longAgo, provider_session_id: 'call_abc123' }, error: null }));
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

      const res = makeRes();
      await handler(controlReq(), res);

      expect(res._status()).toBe(200);
      expect(res._body()).toEqual({ terminate: true, reason: 'max_duration_reached' });
    });

    it('a hangup call for an already-ended call_id (idempotent) never surfaces as an error', async () => {
      const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: longAgo, provider_session_id: 'call_already_ended' }, error: null }));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      const res = makeRes();
      await handler(controlReq(), res);
      expect(res._status()).toBe(200);
      expect(res._body()).toEqual({ terminate: true, reason: 'max_duration_reached' });
    });

    it('ownership: a session-control poll only ever looks up a session scoped to the authenticated user_id — never another user’s session', async () => {
      const now = new Date().toISOString();
      const chain = makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now, provider_session_id: 'call_owner_check' }, error: null });
      mockSessionsFrom.mockReturnValue(chain);
      await handler(controlReq(), makeRes());
      expect(chain.eq).toHaveBeenCalledWith('user_id', USER_ID);
    });
  });

  it('signals terminate when the user has been blocked since the session started', async () => {
    const now = new Date().toISOString();
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now }, error: null }));
    gw.mockEntitlementResolve.mockResolvedValue({
      allowed: false, userId: USER_ID, actorType: 'user', featureKey: 'conversation.webrtc_connect',
      effectivePlanId: null, limits: [], source: 'plan', revision: null, resolvedAt: now,
    });
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ terminate: true, reason: 'user_blocked' });
  });

  it('signals no termination and returns the deadline when everything is healthy', async () => {
    const now = new Date().toISOString();
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now }, error: null }));
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    const body = res._body() as { terminate: boolean; deadlineAt: string };
    expect(body.terminate).toBe(false);
    expect(typeof body.deadlineAt).toBe('string');
  });

  it('scenario 22: reconciles the authorized max seconds on every poll, accounting for time already elapsed this session', async () => {
    const startedAt = new Date(Date.now() - 15 * 1000).toISOString(); // 15s already elapsed
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: startedAt }, error: null }));
    const entitlements = permissiveEntitlements();
    entitlements.conversation.maxRecordingSeconds = 45; // total budget for this call
    entitlements.conversation.maxRecordingUnlimited = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    const body = res._body() as { terminate: boolean; authorizedMaxRecordingSeconds: number; recordingLimitReason: string };
    expect(body.terminate).toBe(false);
    expect(body.recordingLimitReason).toBe('per_turn');
    // 45s total budget - 15s already spent = ~30s left, NOT a fresh 45s.
    expect(body.authorizedMaxRecordingSeconds).toBeCloseTo(30, 0);
  });

  it('fails open (no termination) when a DB/telemetry error occurs', async () => {
    mockSessionsFrom.mockImplementation(() => { throw new Error('db down'); });
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ terminate: false });
  });

  it('an entitlement-resolver failure fails open rather than terminating a healthy session', async () => {
    const now = new Date().toISOString();
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now }, error: null }));
    gw.mockEntitlementResolve.mockRejectedValue(new Error('entitlement service down'));
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as { terminate: boolean }).terminate).toBe(false);
  });

  it('requires authentication like every other bridge route', async () => {
    mockRequireAuth.mockImplementation(async (_req: any, res: any) => {
      res.status(401).json({ error: 'Não autenticado' });
      return null;
    });
    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(401);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  // ── Plan entitlements: commercial recording deadline ─────────────────────

  it('tightens the deadline (and terminates) once the plan max-recording-seconds is reached, before the 30min technical ceiling', async () => {
    const startedAt = new Date(Date.now() - 90 * 1000).toISOString(); // 90s ago
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: startedAt }, error: null }));
    const entitlements = permissiveEntitlements();
    entitlements.conversation.maxRecordingSeconds = 60; // shorter than elapsed 90s
    entitlements.conversation.maxRecordingUnlimited = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ terminate: true, reason: 'plan_recording_limit_reached' });
  });

  it('tightens the deadline using the smaller of per-turn cap and remaining monthly balance', async () => {
    const startedAt = new Date(Date.now() - 20 * 1000).toISOString(); // 20s ago
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: startedAt }, error: null }));
    const entitlements = permissiveEntitlements();
    entitlements.conversation.maxRecordingSeconds = 600; // generous per-turn cap
    entitlements.conversation.maxRecordingUnlimited = false;
    entitlements.conversation.monthlyTime = {
      enabled: true, unlimited: false, limit: 600, consumed: 590, remaining: 10, period: 'month', state: 'available', canStart: true,
    }; // only 10s of monthly balance left — smaller than elapsed 20s
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    // Monthly balance (10s left) is the binding constraint here, not the
    // generous 600s per-turn cap — the reason must say so distinctly.
    expect(res._body()).toEqual({ terminate: true, reason: 'plan_monthly_balance_exhausted' });
  });

  it('does not terminate early when comfortably within both the per-turn cap and the monthly balance', async () => {
    const startedAt = new Date(Date.now() - 5 * 1000).toISOString(); // 5s ago
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: startedAt }, error: null }));
    const entitlements = permissiveEntitlements();
    entitlements.conversation.maxRecordingSeconds = 60;
    entitlements.conversation.maxRecordingUnlimited = false;
    entitlements.conversation.monthlyTime = {
      enabled: true, unlimited: false, limit: 600, consumed: 100, remaining: 500, period: 'month', state: 'available', canStart: true,
    };
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    const body = res._body() as { terminate: boolean };
    expect(body.terminate).toBe(false);
  });

  it('fails open (no early termination) when the plan-limit check itself throws', async () => {
    const now = new Date().toISOString();
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, started_at: now }, error: null }));
    mockGetCurrentUserPlanEntitlements.mockRejectedValue(new Error('entitlements service down'));

    const res = makeRes();
    await handler(controlReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as { terminate: boolean }).terminate).toBe(false);
  });
});

// ── Vercel's REAL catch-all shape — req.query.slug, string AND array ───────
// A previous round of this suite proved the dispatcher routes a *nested*
// two-segment slug (['session', 'active']) correctly — but that was a false
// green: in the actual Vercel deployment, POST /api/conversation/session/active
// 404'd, because Vercel never delivered the second path segment to this
// function's req.query.slug at all (confirmed with real curl requests
// against production). Testing the dispatcher's own switch/resolveSlug
// logic in isolation cannot detect that — it's a platform routing
// contract, not something this file's mocks control. The routes were
// therefore changed to be FLAT, single-segment slugs (session-active, not
// session/active), matching the already-deployed-and-working 'preview' and
// 'session' cases. This suite now proves the flat shape resolves correctly
// under BOTH forms Vercel is documented to use for a single dynamic
// segment: a bare string and a one-element array.

describe('dispatcher — Vercel-shaped req.query.slug (string AND array), flat routes only', () => {
  function vercelReq(slug: string | string[], body: Record<string, unknown> = {}) {
    return { method: 'POST', query: { slug }, headers: { authorization: 'Bearer test-token' }, body };
  }

  it('routes "session" (string) to conversation.create_session, not the webrtc bridge', async () => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSessionSupabase() });
    vi.stubGlobal('fetch', mockClientSecretsFetch(200, { value: 'tok', expires_at: 9999999999, session: { id: 'sess-1' } }));
    const res = makeRes();
    await handler(vercelReq('session'), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('tok');
    expect(mockSessionsFrom).not.toHaveBeenCalled(); // never touches the bridge tables
  });

  it('routes "session-active" (string) to handleSessionActive', async () => {
    const res = makeRes();
    await handler(vercelReq('session-active', { gatewaySessionId: GATEWAY_SESSION_ID }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ featureKey: 'conversation.webrtc_connect' }));
  });

  it('routes ["session-active"] (single-element array) to handleSessionActive — the exact shape that 404\'d in production', async () => {
    const res = makeRes();
    await handler(vercelReq(['session-active'], { gatewaySessionId: GATEWAY_SESSION_ID }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ featureKey: 'conversation.webrtc_connect' }));
  });

  it('routes "session-failed" to handleSessionFailed', async () => {
    const res = makeRes();
    await handler(vercelReq('session-failed', { gatewaySessionId: GATEWAY_SESSION_ID, reason: 'webrtc_failed' }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
  });

  it('routes ["session-failed"] (array) to handleSessionFailed too', async () => {
    const res = makeRes();
    await handler(vercelReq(['session-failed'], { gatewaySessionId: GATEWAY_SESSION_ID, reason: 'webrtc_failed' }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
  });

  it('routes "session-usage" to handleSessionUsage', async () => {
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, metadata: { model: 'gpt-realtime-2.1-mini' } }, error: null }));
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const res = makeRes();
    await handler(vercelReq('session-usage', {
      gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_abc', usage: { input_token_details: { text_tokens: 5 } },
    }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ featureKey: 'conversation.realtime_usage' }));
  });

  it('routes ["session-usage"] (array) to handleSessionUsage too', async () => {
    mockSessionsFrom.mockReturnValue(makeSelectChain({ data: { id: GATEWAY_SESSION_ID, metadata: { model: 'gpt-realtime-2.1-mini' } }, error: null }));
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const res = makeRes();
    await handler(vercelReq(['session-usage'], {
      gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_abc2', usage: { input_token_details: { text_tokens: 5 } },
    }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(expect.objectContaining({ featureKey: 'conversation.realtime_usage' }));
  });

  it('routes "session-end" to handleSessionEnd', async () => {
    mockSessionsFrom
      .mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID, started_at: new Date(0).toISOString() }, error: null }))
      .mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null })) // duration/measurement_source follow-up UPDATE
      .mockReturnValueOnce(makeSelectChain({ data: { id: 'eeeeeeee-0000-0000-0000-000000000009' }, error: null }));
    const res = makeRes();
    await handler(vercelReq('session-end', { gatewaySessionId: GATEWAY_SESSION_ID }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockInsertMetrics).toHaveBeenCalledWith(
      'eeeeeeee-0000-0000-0000-000000000009',
      [expect.objectContaining({ metricKey: 'session_seconds' })],
    );
  });

  it('routes ["session-end"] (array) to handleSessionEnd too', async () => {
    mockSessionsFrom
      .mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID, started_at: new Date(0).toISOString() }, error: null }))
      .mockReturnValueOnce(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null })) // duration/measurement_source follow-up UPDATE
      .mockReturnValueOnce(makeSelectChain({ data: { id: 'eeeeeeee-0000-0000-0000-00000000000a' }, error: null }));
    const res = makeRes();
    await handler(vercelReq(['session-end'], { gatewaySessionId: GATEWAY_SESSION_ID }), res);
    expect(res._status()).toBe(200);
    expect(gw.mockInsertMetrics).toHaveBeenCalledWith(
      'eeeeeeee-0000-0000-0000-00000000000a',
      [expect.objectContaining({ metricKey: 'session_seconds' })],
    );
  });

  it('the nested two-segment shape is no longer routable at all — proves the old paths are truly gone, not just unused', async () => {
    const res = makeRes();
    await handler(vercelReq(['session', 'active'], { gatewaySessionId: GATEWAY_SESSION_ID }), res);
    expect(res._status()).toBe(404);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('all four bridge routes require authentication — an unauthenticated request never reaches the bridge logic', async () => {
    mockRequireAuth.mockImplementation(async (_req: any, res: any) => {
      res.status(401).json({ error: 'Não autenticado' });
      return null;
    });
    for (const slug of ['session-active', 'session-failed', 'session-usage', 'session-end', 'session-control']) {
      const res = makeRes();
      await handler(vercelReq(slug, { gatewaySessionId: GATEWAY_SESSION_ID }), res);
      expect(res._status()).toBe(401);
    }
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });
});
