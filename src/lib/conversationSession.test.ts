import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

// ── Source-code smoke tests ──────────────────────────────────────────────────
// These verify that the GA endpoints are used and the Beta endpoints are gone.

describe('conversationSession — source code must use GA endpoints', () => {
  it('backend does not use the Beta sessions endpoint', async () => {
    const src = await import('../../api/conversation/[...slug]?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).not.toContain('/v1/realtime/sessions');
    expect(code).toContain('/v1/realtime/client_secrets');
  });

  it('frontend hook does not use the old /realtime?model= endpoint', async () => {
    const src = await import('../hooks/useRealtimeSession?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).not.toContain('/v1/realtime?model=');
  });

  it('frontend hook never talks to OpenAI directly for the SDP/WebRTC leg (Etapa 11 unified interface) — it posts to this backend, which makes that call server-to-server', async () => {
    const src = await import('../hooks/useRealtimeSession?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).not.toContain('api.openai.com');
    expect(code).toContain('/api/conversation/webrtc-connect');
  });

  it('backend (not the browser) POSTs the SDP offer to the real /v1/realtime/calls endpoint', async () => {
    const src = await import('../../api/conversation/[...slug]?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).toContain('/v1/realtime/calls');
  });
});

// ── VAD pause-tolerance smoke test ────────────────────────────────────────────
// Verifies the server-side VAD configuration gives the user enough silence
// tolerance (~2.5 s) before treating a pause as end-of-speech.

describe('conversationSession — VAD silence tolerance', () => {
  it('session config uses silence_duration_ms of at least 2000ms to allow natural pauses', async () => {
    const src = await import('../../api/conversation/[...slug]?raw');
    const code = (src as unknown as { default: string }).default;
    // Extract the numeric value after "silence_duration_ms:"
    const match = code.match(/silence_duration_ms\s*:\s*(\d+)/);
    expect(match).not.toBeNull();
    const value = match ? parseInt(match[1], 10) : 0;
    expect(value).toBeGreaterThanOrEqual(2000);
  });

  it('session config does NOT use the old 800ms silence_duration_ms', async () => {
    const src = await import('../../api/conversation/[...slug]?raw');
    const code = (src as unknown as { default: string }).default;
    // Ensure the old too-short value is gone
    expect(code).not.toMatch(/silence_duration_ms\s*:\s*800\b/);
  });

  it('session config uses server_vad turn detection', async () => {
    const src = await import('../../api/conversation/[...slug]?raw');
    const code = (src as unknown as { default: string }).default;
    expect(code).toContain("'server_vad'");
  });
});

// ── Backend handler tests ────────────────────────────────────────────────────
// Etapa 10 wires conversation.create_session through executeAiGatewayCall,
// which resolves policy via getProductionDeps() before doing anything else
// (even in legacy mode). These pre-existing tests never exercise gateway
// behavior directly, so they get a legacy-mode stub — same pattern as
// pronunciation-token-gateway.test.ts — keeping every assertion below about
// the pre-existing OpenAI response mapping unchanged.

vi.mock('../../api/_auth', () => ({ requireAuth: vi.fn() }));

const { mockGetCurrentUserPlanEntitlements } = vi.hoisted(() => ({
  mockGetCurrentUserPlanEntitlements: vi.fn(),
}));
vi.mock('../../api/_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

vi.mock('../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_ai-gateway/index')>();
  return {
    ...actual,
    getProductionDeps: () => ({
      policyResolver: { resolvePolicy: async () => ({ gatewayMode: 'legacy', runtimeStatus: 'enabled' }), invalidate: () => {} },
      usageRepository: {} as unknown,
      pricingRepository: {} as unknown,
      dailyRollupRepository: {} as unknown,
      clock: () => Date.now(),
      uuidGen: () => 'test-uuid',
      logger: () => {},
    }),
  };
});

import { requireAuth } from '../../api/_auth';
import handler from '../../api/conversation/[...slug]';

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

// ── Chainable Supabase mock that fully exercises rowToPrefs() ───────────────
// The minimal `makeSupabase` above throws inside handleSession's try/catch
// (its chain lacks .order()/.eq()), so `prefs` silently falls back to
// BASE_DEFAULTS and rowToPrefs() never actually runs on the DB row. This
// fuller mock resolves every chain call so we can exercise the real
// teacher_name → instructions path end to end.
function makeChainableSupabase(rows: {
  prefs?: Record<string, unknown> | null;
}) {
  function makeChain(data: unknown) {
    const chain: any = {
      select:      () => chain,
      eq:          () => chain,
      order:       () => chain,
      limit:       () => chain,
      maybeSingle: () => Promise.resolve({ data }),
      then:        (resolve: (v: { data: unknown }) => void) => resolve({ data }),
    };
    return chain;
  }

  let englishReviewsCalls = 0;

  return {
    from: vi.fn((table: string) => {
      if (table === 'ai_conversation_preferences') return makeChain(rows.prefs ?? null);
      if (table === 'english_learning_memory') return makeChain([]);
      if (table === 'english_reviews') {
        englishReviewsCalls++;
        // 1st call: today's review (.maybeSingle()) — 2nd call: recent mistakes (.limit())
        return makeChain(englishReviewsCalls === 1 ? null : []);
      }
      if (table === 'conversation_sessions') return makeChain([]);
      return makeChain(null);
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
  return { method: 'POST', url: '/api/conversation/session', body, headers: {} };
}

function mockFetch(status: number, body: unknown) {
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
  vi.restoreAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'sk-test-key');
  vi.stubEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime-2.1-mini');
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
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

// ── Identity regression: stale/legacy teacher_name must never reach the model ─
// Reproduces the reported bug: a DB row saved before the app's rename still
// holds teacher_name: 'Alex'. The realtime voice prompt must always assert
// the fixed "Lemon" identity regardless of that stored value.

describe('conversationSession handler — assistant identity is fixed', () => {
  it('sends "Lemon" identity instructions even when the DB row has a stale teacher_name', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeChainableSupabase({ prefs: { teacher_name: 'Alex' } }) as any,
    });
    const globalFetch = mockFetch(200, { value: 'tok', expires_at: 9999, session: { id: 'x' } });
    vi.stubGlobal('fetch', globalFetch);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    const [, opts] = globalFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
    const sentBody = JSON.parse(opts.body as unknown as string);
    const instructions = sentBody.session.instructions as string;

    expect(instructions).toContain('Your name is Lemon');
    expect(instructions).not.toMatch(/Você é Alex\b/);
    expect(instructions).not.toContain('Alex, um');
  });

  it('sends "Lemon" identity instructions when there is no preferences row yet', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeChainableSupabase({ prefs: null }) as any,
    });
    const globalFetch = mockFetch(200, { value: 'tok', expires_at: 9999, session: { id: 'x' } });
    vi.stubGlobal('fetch', globalFetch);

    const res = makeRes();
    await handler(makeReq(), res);

    const [, opts] = globalFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
    const sentBody = JSON.parse(opts.body as unknown as string);
    expect((sentBody.session.instructions as string)).toContain('Your name is Lemon');
  });
});

// ── AI Gateway (Etapa 10) — legacy mode preserves current behavior exactly ──

describe('conversationSession handler — AI Gateway legacy mode', () => {
  it('does not include gatewaySessionId in the response while legacy (the default/current state)', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    vi.stubGlobal('fetch', mockFetch(200, { value: 'tok', expires_at: 9999999999, session: { id: 'sess-x', model: 'gpt-realtime-2.1-mini' } }));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    expect((res._json as any).gatewaySessionId).toBeUndefined();
    // Every existing response field is still present and unchanged.
    expect((res._json as any).token).toBe('tok');
    expect((res._json as any).sessionId).toBe('sess-x');
  });

  it('the client_secrets call is still made exactly once (gateway wraps, never duplicates, the call)', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: MOCK_USER_ID,
      supabase: makeSupabase() as any,
    });
    const globalFetch = mockFetch(200, { value: 'tok', expires_at: 9999999999, session: { id: 'sess-y' } });
    vi.stubGlobal('fetch', globalFetch);

    await handler(makeReq(), makeRes());

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Client-side chain: gatewaySessionId → useRealtimeSession → bridge calls ──
// Proves the full wiring the production incident exposed: the backend can
// authorize a session and return gatewaySessionId correctly (proven
// separately in api/__tests__/conversation-session-gateway.test.ts, "observe
// for both create_session and webrtc_connect" describe block) — but that
// alone is worthless if the frontend hook never reads, stores, or acts on
// the field. No jsdom/RTL is set up in this project (see
// useConversationCaptions.test.ts for the established convention), so these
// are precise raw-source assertions on the exact call sites, not merely
// "the string exists somewhere."

describe('client-side gatewaySessionId chain (useRealtimeSession.ts)', () => {
  async function hookSource(): Promise<string> {
    const src = await import('../hooks/useRealtimeSession?raw');
    // Normalize CRLF → LF so multi-line substring assertions below are
    // agnostic to the file's on-disk line-ending style.
    return (src as unknown as { default: string }).default.replace(/\r\n/g, '\n');
  }

  it('parses gatewaySessionId from the /api/conversation/session response body and stores it in a ref', async () => {
    const code = await hookSource();
    expect(code).toMatch(/gatewaySessionId\?:\s*string/); // typed as optional on the parsed body
    expect(code).toContain("gatewaySessionIdRef.current = typeof body.gatewaySessionId === 'string' ? body.gatewaySessionId : null;");
  });

  it('reportSessionActive is called from dc.onopen — after the data channel actually opens, not at token issuance or SDP send', async () => {
    const code = await hookSource();
    const onopenBlock = code.slice(code.indexOf('dc.onopen = () => {'), code.indexOf('dc.onmessage = (e) => {'));
    // Etapa 11, unified interface — call_id is no longer client-reported at
    // all (captured server-side by handleWebrtcConnect at SDP-negotiation
    // time), so reportSessionActive takes only gatewaySessionId now.
    expect(onopenBlock).toContain('reportSessionActive(gatewaySessionIdRef.current)');
    // Guarded — never called unconditionally (legacy: ref stays null, no-op).
    expect(onopenBlock).toMatch(/if \(gatewaySessionIdRef\.current\) \{\s*sessionReportedActiveRef\.current = true;\s*reportSessionActive/);
  });

  it('reportSessionActive is not called anywhere in the start() body before dc.onopen (not at Step 2 token fetch, not at Step 5 SDP POST)', async () => {
    const code = await hookSource();
    // Scoped to inside start()'s body, after the import statement (which
    // legitimately names reportSessionActive) and up to dc.onopen's own definition.
    const startBodyStart = code.indexOf('const start = useCallback(async () => {');
    const dataChannelIdx = code.indexOf("const dc = pc.createDataChannel('oai-events');");
    expect(startBodyStart).toBeGreaterThan(-1);
    expect(dataChannelIdx).toBeGreaterThan(startBodyStart);
    const beforeDataChannel = code.slice(startBodyStart, dataChannelIdx);
    expect(beforeDataChannel).not.toContain('reportSessionActive');
  });

  it('reportSessionUsage is called from response.done, reading the official response.id and response.usage fields', async () => {
    const code = await hookSource();
    const doneBlock = code.slice(code.indexOf("if (ev.type === 'response.done')"), code.indexOf("// Error events from the server"));
    expect(doneBlock).toContain('reportSessionUsage(gatewaySessionIdRef.current, ev.response.id, ev.response.usage)');
  });

  it('end() (the "Encerrar conversa" button) and dc.onclose both route through cleanup(), which calls reportSessionEnd when the session was active', async () => {
    const code = await hookSource();
    expect(code).toContain("const end = useCallback(() => {\n    cleanup('ended', 'user_ended');");
    expect(code).toContain("dc.onclose = () => {\n      if (!endCalledRef.current) cleanup('ended', 'dc_closed');");
    expect(code).toContain('reportSessionEnd(gatewaySessionId)');
  });

  it('gatewaySessionIdRef is cleared immediately inside cleanup() before firing the report — a second cleanup() call (Strict Mode double-invoke, end() then dc.onclose) is a client-side no-op', async () => {
    const code = await hookSource();
    const cleanupBody = code.slice(code.indexOf('const cleanup = useCallback'), code.indexOf('useEffect(() => () => { cleanup(undefined'));
    // gatewaySessionIdRef.current is nulled out INSIDE the `if (gatewaySessionId)` guard,
    // before either report call — so a second invocation reads null and skips entirely.
    expect(cleanupBody).toMatch(/if \(gatewaySessionId\) \{\s*gatewaySessionIdRef\.current = null;\s*sessionReportedActiveRef\.current = false;/);
  });

  it('when gatewaySessionId is absent (legacy — the current production state), no bridge report is ever fired', async () => {
    const code = await hookSource();
    // Every call site is guarded by `if (gatewaySessionIdRef.current)` / `if (gatewaySessionId)` —
    // never an unconditional call.
    const reportCalls = [...code.matchAll(/report(Session\w+)\(/g)];
    expect(reportCalls.length).toBeGreaterThan(0);
    for (const call of reportCalls) {
      const before = code.slice(0, call.index);
      const lastGuard = before.lastIndexOf('if (gatewaySessionId');
      const lastBrace = before.lastIndexOf('\n  }, []);'); // end of a previous, unrelated useCallback
      expect(lastGuard).toBeGreaterThan(-1);
      expect(lastGuard).toBeGreaterThan(lastBrace - 200); // guard is the nearest preceding conditional
    }
  });

  it('no test, source file, or log statement in the bridge chain contains the ephemeral token, transcript, or SDP content', async () => {
    const hookCode = await hookSource();
    const reportingSrc = await import('../lib/realtimeGatewayReporting?raw');
    const reportingCode = (reportingSrc as unknown as { default: string }).default;
    // The reporting calls themselves only ever pass gatewaySessionId, a
    // provider response id, numeric usage counters, or a small reason enum —
    // never `token`, `answerSdp`, or `transcriptAccumRef`.
    const activeCallLine = hookCode.match(/reportSessionActive\([^)]*\)/)?.[0] ?? '';
    const usageCallLine = hookCode.match(/reportSessionUsage\([^)]*\)/)?.[0] ?? '';
    const endCallLine = hookCode.match(/reportSessionEnd\([^)]*\)/)?.[0] ?? '';
    for (const line of [activeCallLine, usageCallLine, endCallLine]) {
      expect(line).not.toMatch(/token|answerSdp|transcriptAccumRef/);
    }
    expect(reportingCode).not.toMatch(/console\.(log|error)\([^)]*\btoken\b/i);
  });
});
