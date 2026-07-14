import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Source-code smoke tests ──────────────────────────────────────────────────
// These verify that the GA endpoints are used and the Beta endpoints are gone.

describe('conversationSession — source code must use GA endpoints', () => {
  it('backend does not use the Beta sessions endpoint', async () => {
    const src = await import('../../api/conversation/session?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).not.toContain('/v1/realtime/sessions');
    expect(code).toContain('/v1/realtime/client_secrets');
  });

  it('frontend hook does not use the old /realtime?model= endpoint', async () => {
    const src = await import('../hooks/useRealtimeSession?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).not.toContain('/v1/realtime?model=');
    expect(code).toContain('/v1/realtime/calls');
  });
});

// ── Backend handler tests ────────────────────────────────────────────────────

vi.mock('../../api/_auth', () => ({ requireAuth: vi.fn() }));

import { requireAuth } from '../../api/_auth';
import handler from '../../api/conversation/session';

const MOCK_USER_ID = '123e4567-e89b-12d3-a456-426614174000';

function makeSupabase(prefsRow: Record<string, unknown> | null = null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: prefsRow }),
      }),
    }),
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _json: null as unknown,
    _headers: {} as Record<string, string>,
    status(s: number) { res._status = s; return res; },
    json(j: unknown) { res._json = j; return res; },
    end() { return res; },
    setHeader(k: string, v: string) { res._headers[k] = v; },
  };
  return res;
}

function makeReq(body = {}) {
  return { method: 'POST', body, headers: {} };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'req-id-123' },
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'sk-test-key');
  vi.stubEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime-2.1-mini');
});

describe('conversationSession handler — GA format', () => {
  it('returns 503 when OPENAI_API_KEY is missing', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(503);
    expect((res._json as any).code).toBe('OPENAI_NOT_CONFIGURED');
  });

  it('calls /v1/realtime/client_secrets and returns token on success', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    const gaResponse = {
      value: 'ephemeral-token-abc',
      expires_at: 9999999999,
      session: { id: 'sess-123', model: 'gpt-realtime-2.1-mini' },
    };
    const globalFetch = mockFetch(200, gaResponse);
    vi.stubGlobal('fetch', globalFetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(globalFetch).toHaveBeenCalledOnce();
    const [url, opts] = globalFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(opts.headers['OpenAI-Safety-Identifier']).toMatch(/^[a-f0-9]{64}$/);
    // ensure main API key is in Authorization, not leaked elsewhere
    expect(opts.headers['Authorization']).toBe('Bearer sk-test-key');

    expect(res._status).toBe(200);
    expect((res._json as any).token).toBe('ephemeral-token-abc');
    expect((res._json as any).sessionId).toBe('sess-123');
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('maps 429 to OPENAI_RATE_LIMITED', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    vi.stubGlobal('fetch', mockFetch(429, { error: { type: 'rate_limit', message: 'Too many requests' } }));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(429);
    expect((res._json as any).code).toBe('OPENAI_RATE_LIMITED');
    expect((res._json as any).message).toContain('limite');
  });

  it('maps 401 to OPENAI_AUTH_FAILED', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    vi.stubGlobal('fetch', mockFetch(401, { error: { type: 'invalid_api_key' } }));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(401);
    expect((res._json as any).code).toBe('OPENAI_AUTH_FAILED');
  });

  it('maps 500 to OPENAI_UNAVAILABLE', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    vi.stubGlobal('fetch', mockFetch(500, { error: { type: 'server_error' } }));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(502);
    expect((res._json as any).code).toBe('OPENAI_UNAVAILABLE');
  });

  it('rejects GA response missing value field', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    vi.stubGlobal('fetch', mockFetch(200, { expires_at: 9999999 })); // no value

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(502);
    expect((res._json as any).code).toBe('OPENAI_SESSION_FAILED');
  });

  it('does not expose the API key in the response', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    vi.stubGlobal('fetch', mockFetch(200, {
      value: 'tok',
      expires_at: 9999,
      session: { id: 'x' },
    }));

    const res = makeRes();
    await handler(makeReq(), res);

    const body = JSON.stringify(res._json);
    expect(body).not.toContain('sk-test-key');
  });

  it('sends SHA-256 of userId, not raw UUID', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    const globalFetch = mockFetch(200, { value: 'tok', expires_at: 9999, session: { id: 'x' } });
    vi.stubGlobal('fetch', globalFetch);

    const res = makeRes();
    await handler(makeReq(), res);

    const [, opts] = globalFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(opts.headers['OpenAI-Safety-Identifier']).not.toContain(MOCK_USER_ID);
    expect(opts.headers['OpenAI-Safety-Identifier']).toMatch(/^[a-f0-9]{64}$/);
  });
});
