/**
 * Tests for POST /api/conversation/webrtc-connect (handleWebrtcConnect) —
 * Etapa 11 unified interface. This backend now makes the SDP POST to
 * OpenAI itself (server-to-server) instead of the browser doing it
 * directly, so it can reliably read the Location response header (call_id)
 * on every call — no CORS dependency, unlike the old client-side capture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockSessionsFrom, sessionsClient } = vi.hoisted(() => {
  const mockRequireAuth = vi.fn();
  const mockSessionsFrom = vi.fn();
  return { mockRequireAuth, mockSessionsFrom, sessionsClient: { from: mockSessionsFrom } };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getSharedServiceClient: () => sessionsClient };
});
vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(true) }));

import handler from '../conversation/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000031';
const GATEWAY_SESSION_ID = 'cccccccc-0000-0000-0000-000000000001';

function makeUpdateChain() {
  const chain: any = {};
  for (const m of ['update', 'eq', 'in']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.then = (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null });
  return chain;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/conversation/webrtc-connect',
    headers: { authorization: 'Bearer test-token' },
    body: { sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n', ephemeralToken: 'ek_test_token' },
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

function mockOpenAiCallsFetch(status: number, answerSdp: string, locationHeader: string | null) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'Location' ? locationHeader : null) },
    text: vi.fn().mockResolvedValue(answerSdp),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID });
  mockSessionsFrom.mockReturnValue(makeUpdateChain());
});

describe('POST /webrtc-connect — validation', () => {
  it('rejects a missing sdp', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ephemeralToken: 'ek_x' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_SDP');
  });

  it('rejects a missing ephemeralToken', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { sdp: 'v=0' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('MISSING_EPHEMERAL_TOKEN');
  });

  it('rejects a malformed gatewaySessionId', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { sdp: 'v=0', ephemeralToken: 'ek_x', gatewaySessionId: 'not-a-uuid' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_GATEWAY_SESSION_ID');
  });

  it('requires authentication', async () => {
    mockRequireAuth.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });
});

describe('POST /webrtc-connect — forwards to OpenAI server-to-server', () => {
  it('POSTs the exact SDP offer to the real OpenAI endpoint, authenticated with the ephemeral token (never the real API key)', async () => {
    const fetchMock = mockOpenAiCallsFetch(201, 'v=0 answer', '/v1/realtime/calls/rtc_abc123');
    vi.stubGlobal('fetch', fetchMock);

    await handler(makeReq(), makeRes());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/calls',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ek_test_token', 'Content-Type': 'application/sdp' }),
        body: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
      }),
    );
  });

  it('returns the SDP answer as JSON { sdp }', async () => {
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, 'v=0 answer-sdp-text', '/v1/realtime/calls/rtc_abc123'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ sdp: 'v=0 answer-sdp-text' });
  });

  it('a non-ok OpenAI response surfaces as WEBRTC_FAILED, 502', async () => {
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(400, '', null));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(502);
    expect((res._body() as any).code).toBe('WEBRTC_FAILED');
  });

  it('a network failure surfaces as WEBRTC_NETWORK, 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(502);
    expect((res._body() as any).code).toBe('WEBRTC_NETWORK');
  });

  it('an empty SDP answer body surfaces as WEBRTC_FAILED, 502', async () => {
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, '', '/v1/realtime/calls/rtc_abc123'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(502);
    expect((res._body() as any).code).toBe('WEBRTC_FAILED');
  });
});

describe('POST /webrtc-connect — server-side call_id capture (the whole point of this endpoint)', () => {
  it('extracts call_id from the Location header and persists it to ai_provider_sessions when gatewaySessionId is present', async () => {
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, 'v=0 answer', '/v1/realtime/calls/rtc_abc123'));
    await handler(makeReq({ body: { sdp: 'v=0', ephemeralToken: 'ek_x', gatewaySessionId: GATEWAY_SESSION_ID } }), makeRes());

    expect(mockSessionsFrom).toHaveBeenCalledWith('ai_provider_sessions');
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({ provider_session_id: 'rtc_abc123' });
    expect(chain.eq).toHaveBeenCalledWith('id', GATEWAY_SESSION_ID);
  });

  it('never persists anything when gatewaySessionId is absent (legacy mode) — the SDP proxy still works either way', async () => {
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, 'v=0 answer', '/v1/realtime/calls/rtc_abc123'));
    const res = makeRes();
    await handler(makeReq({ body: { sdp: 'v=0', ephemeralToken: 'ek_x' } }), res);

    expect(mockSessionsFrom).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('a missing Location header never persists a call_id and still returns the SDP answer successfully', async () => {
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, 'v=0 answer', null));
    const res = makeRes();
    await handler(makeReq({ body: { sdp: 'v=0', ephemeralToken: 'ek_x', gatewaySessionId: GATEWAY_SESSION_ID } }), res);

    expect(mockSessionsFrom).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
  });

  it('a Location header whose last path segment has an unsafe charset is rejected, never persisted raw', async () => {
    // Only the last '/'-separated segment is ever considered — this proves
    // that segment itself is still charset-validated (never trusted just
    // because it survived the split), not that the path-traversal
    // characters elsewhere in the header do anything (they don't reach
    // extraction at all).
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, 'v=0 answer', '/v1/realtime/calls/rtc abc$123'));
    await handler(makeReq({ body: { sdp: 'v=0', ephemeralToken: 'ek_x', gatewaySessionId: GATEWAY_SESSION_ID } }), makeRes());
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('a call_id persistence failure never blocks returning the SDP answer to the browser (best-effort)', async () => {
    mockSessionsFrom.mockImplementation(() => { throw new Error('db down'); });
    vi.stubGlobal('fetch', mockOpenAiCallsFetch(201, 'v=0 answer', '/v1/realtime/calls/rtc_abc123'));
    const res = makeRes();
    await handler(makeReq({ body: { sdp: 'v=0', ephemeralToken: 'ek_x', gatewaySessionId: GATEWAY_SESSION_ID } }), res);
    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ sdp: 'v=0 answer' });
  });
});
