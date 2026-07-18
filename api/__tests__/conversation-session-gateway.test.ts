/**
 * Integration tests for api/conversation/[...slug].ts — AI Gateway
 * integration (Etapa 10):
 *   - conversation.create_session: backend-wrapped client_secrets call, plus
 *     the ai_provider_sessions bridge authorized for conversation.webrtc_connect.
 *   - conversation.webrtc_connect: session/active, session/failed, session/end
 *     — the authenticated bridge the browser reports connection outcome to.
 *   - conversation.realtime_usage: session/usage — idempotent per-response
 *     token relay, deduplicated by (provider_session_record_id, providerRequestId).
 *
 * Scope: requireAuth and the existing /session pedagogical response shape
 * (instructions, prefs, etc.) are unaffected — this file only asserts
 * Gateway/session behavior layered additively on top.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';

const { mockRequireAuth, gw } = vi.hoisted(() => {
  const mockRequireAuth = vi.fn();
  return { mockRequireAuth, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

// Separate mock Supabase client standing in for getSharedServiceClient() —
// used only by the session-transition bridge code (session/active, /failed,
// /usage, /end), distinct from the per-request `supabase` (requireAuth) used
// by the existing /session pedagogical-context queries.
const { mockSessionsFrom, sessionsClient } = vi.hoisted(() => {
  const mockSessionsFrom = vi.fn();
  return { mockSessionsFrom, sessionsClient: { from: mockSessionsFrom } };
});

function makeUpdateChain(result: { data: { id: string } | null; error: unknown }) {
  const chain: any = {};
  for (const m of ['update', 'eq', 'in', 'or', 'select']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}
function makeSelectChain(result: { data: { id: string; metadata?: Record<string, unknown> } | null; error: unknown }) {
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

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSessionSupabase() });
  mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: { id: GATEWAY_SESSION_ID }, error: null }));
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
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
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

// ── conversation.webrtc_connect — /session/active ───────────────────────────

describe('POST /session/active — conversation.webrtc_connect', () => {
  function activeReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID }) {
    return makeReq({ url: '/api/conversation/session/active', body });
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
    expect(metrics).toEqual([expect.objectContaining({ metricKey: 'provider_requests', isBillable: false, measurementSource: 'provider_event_client_relayed' })]);
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
});

// ── conversation.webrtc_connect — /session/failed ───────────────────────────

describe('POST /session/failed — conversation.webrtc_connect', () => {
  function failedReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID, reason: 'webrtc_failed' }) {
    return makeReq({ url: '/api/conversation/session/failed', body });
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

// ── conversation.realtime_usage — /session/usage ────────────────────────────

const FULL_USAGE = {
  input_token_details: { text_tokens: 100, audio_tokens: 5000, cached_tokens_details: { text_tokens: 20, audio_tokens: 1000 } },
  output_token_details: { text_tokens: 50, audio_tokens: 3000 },
};

function usageReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID, providerResponseId: 'resp_abc123', usage: FULL_USAGE }) {
  return makeReq({ url: '/api/conversation/session/usage', body });
}

describe('POST /session/usage — conversation.realtime_usage', () => {
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

// ── conversation.webrtc_connect — /session/end ──────────────────────────────

describe('POST /session/end — conversation.webrtc_connect', () => {
  function endReq(body: Record<string, unknown> = { gatewaySessionId: GATEWAY_SESSION_ID, durationSeconds: 187.5 }) {
    return makeReq({ url: '/api/conversation/session/end', body });
  }

  it('completes the session and records a session_seconds metric (non-billable, call_sequence=2)', async () => {
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);

    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', duration_seconds: 187.5 }));

    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: 'conversation.webrtc_connect', callSequence: 2, isBillable: false }),
    );
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toEqual([expect.objectContaining({ metricKey: 'session_seconds', quantity: 187.5, isBillable: false })]);
  });

  it('a session that was never activated (still authorized/connecting) cannot be completed — no-op', async () => {
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('a duplicate /end call for an already-completed session is a no-op — completes exactly once', async () => {
    // First call succeeds (status IN ('active') matches).
    await handler(endReq(), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);

    // Second call: the atomic UPDATE...WHERE status='active' now matches
    // nothing (already 'completed').
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    await handler(endReq(), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1); // unchanged — no second event
  });

  it('rejects a negative duration', async () => {
    const res = makeRes();
    await handler(endReq({ gatewaySessionId: GATEWAY_SESSION_ID, durationSeconds: -5 }), res);
    expect(res._status()).toBe(400);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('rejects an implausibly large duration (well above MAX_SESSION_MS)', async () => {
    const res = makeRes();
    await handler(endReq({ gatewaySessionId: GATEWAY_SESSION_ID, durationSeconds: 999_999 }), res);
    expect(res._status()).toBe(400);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('duration does not depend on playback speed — it is the raw seconds value reported, stored verbatim', async () => {
    await handler(endReq({ gatewaySessionId: GATEWAY_SESSION_ID, durationSeconds: 42 }), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics[0].quantity).toBe(42);
  });

  it('another user cannot end this session', async () => {
    mockRequireAuth.mockResolvedValue({ userId: OTHER_USER_ID, supabase: makeSessionSupabase() });
    mockSessionsFrom.mockReturnValue(makeUpdateChain({ data: null, error: null }));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('a telemetry failure never surfaces as an error to the browser (fail-open)', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await handler(endReq(), res);
    expect(res._status()).toBe(200);
  });
});
