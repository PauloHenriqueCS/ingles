/**
 * Integration tests for api/conversation/[...slug].ts — AI Gateway
 * integration (Etapa 10), conversation.preview_tts.
 *
 * Scope: requireAuth, rate limiting, voice validation and the existing
 * preview-audio response shape are unaffected — this file only asserts
 * Gateway/telemetry behavior layered additively on top.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import { countTtsPlainTextCharacters } from '../_ai-gateway/tts-character-count';
import { estimateTtsCharacters, estimateProviderRequests } from '../_ai-gateway/estimators';

const { mockRequireAuth, gw, capturedContexts, mockDownload, mockUpload } = vi.hoisted(() => {
  const mockRequireAuth = vi.fn();
  return {
    mockRequireAuth,
    gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps>,
    capturedContexts: [] as any[],
    mockDownload: vi.fn(),
    mockUpload: vi.fn(),
  };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return {
    ...actual,
    getProductionDeps: () => gw.mockDeps,
    // Shared-cache storage stub for the voice-preview cache (download/upload).
    getSharedServiceClient: () => ({ storage: { from: () => ({ download: mockDownload, upload: mockUpload }) } }),
    executeAiGatewayCall: (async (context: any, ...rest: any[]) => {
      capturedContexts.push(context);
      return (actual.executeAiGatewayCall as any)(context, ...rest);
    }) as typeof actual.executeAiGatewayCall,
  };
});

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(true) }));

import handler from '../conversation/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000021';

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: '/api/conversation/preview',
    headers: { authorization: 'Bearer test-token' },
    body: { voice: 'coral', pace: 'normal' },
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  let _sent: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    _sent: () => _sent,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    send(b: unknown) { _sent = b; return res; },
    setHeader: vi.fn(),
  };
  return res;
}

function mockOpenAiTtsFetch(status: number, audioByteLength = 128) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new ArrayBuffer(audioByteLength),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedContexts.length = 0;
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  process.env.OPENAI_API_KEY = 'sk-test-key';
  // Default: preview cache MISS → the generate path runs (as before this cache).
  mockDownload.mockResolvedValue({ data: null, error: { message: 'not found' } });
  mockUpload.mockResolvedValue({ error: null });
});

describe('LEGACY mode', () => {
  it('returns the audio and writes no telemetry (current behavior unchanged)', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._sent()).toBeInstanceOf(Buffer);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one physical call for conversation.preview_tts, provider openai, model gpt-4o-mini-tts', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    await handler(makeReq(), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'conversation.preview_tts',
        provider: 'openai',
        service: 'audio.speech',
        model: 'gpt-4o-mini-tts',
        userId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
      }),
    );
  });

  it('records provider_requests=1 (not billable) and tts_characters (billable) with a deterministic count', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    await handler(makeReq(), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
    const ttsMetric = metrics.find((m) => m.metricKey === 'tts_characters') as Record<string, unknown>;
    expect(ttsMetric).toBeDefined();
    expect(ttsMetric.isBillable).toBe(true);
    expect(typeof ttsMetric.quantity).toBe('number');
    expect(ttsMetric.quantity as number).toBeGreaterThan(0);
  });

  it('preserves the requested voice and speed in the physical OpenAI call body', async () => {
    const globalFetch = mockOpenAiTtsFetch(200);
    vi.stubGlobal('fetch', globalFetch);
    await handler(makeReq({ body: { voice: 'ash', pace: 'slow' } }), makeRes());

    const [url, opts] = globalFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    const sentBody = JSON.parse(opts.body as string);
    expect(sentBody.voice).toBe('ash'); // REALTIME_VOICES['ash'].previewVoice === 'ash'
    expect(sentBody.speed).toBe(0.82);  // PREVIEW_SPEED.slow, unchanged by the gateway wrap
    expect(sentBody.model).toBe('gpt-4o-mini-tts');
  });

  it('character count matches countTtsPlainTextCharacters of the actual phrase sent (accents/emoji-safe utility, reused not reimplemented)', async () => {
    const globalFetch = mockOpenAiTtsFetch(200);
    vi.stubGlobal('fetch', globalFetch);
    await handler(makeReq(), makeRes());

    const [, opts] = globalFetch.mock.calls[0] as [string, RequestInit];
    const sentInput = (JSON.parse(opts.body as string) as { input: string }).input;
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    const ttsMetric = metrics.find((m) => m.metricKey === 'tts_characters') as Record<string, unknown>;
    expect(ttsMetric.quantity).toBe(countTtsPlainTextCharacters(sentInput));
  });

  it('estimatedMetrics (the pre-call reservation) exactly matches the real text about to be sent — same counter as the real tts_characters metric, computed before the physical call', async () => {
    const globalFetch = mockOpenAiTtsFetch(200);
    vi.stubGlobal('fetch', globalFetch);
    await handler(makeReq(), makeRes());

    const [, opts] = globalFetch.mock.calls[0] as [string, RequestInit];
    const sentInput = (JSON.parse(opts.body as string) as { input: string }).input;
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0].estimatedMetrics).toEqual([
      estimateProviderRequests(1),
      estimateTtsCharacters(sentInput, false),
    ]);
  });

  it('an OpenAI HTTP error creates a failed event and preserves the previous error mapping', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(500));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(502);
    expect((res._body() as any).code).toBe('PREVIEW_FAILED');
  });

  it('a timeout (AbortError) maps to 504 AI_TIMEOUT exactly as before', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(504);
    expect((res._body() as any).code).toBe('AI_TIMEOUT');
  });

  it('a telemetry start failure never prevents the preview audio from being returned (fail-open)', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._sent()).toBeInstanceOf(Buffer);
  });

  it('a cost calculation failure never affects the response', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    gw.mockGetEventForCosting.mockRejectedValue(new Error('pricing db down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
  });

  it('never logs or stores the synthesized text, prompt, or audio in metadata', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    await handler(makeReq(), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    const payload = JSON.stringify(startCall);
    expect(payload).not.toContain('speaking at a');
  });

  it('invalid voice is still rejected before any gateway call is made', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { voice: 'not-a-real-voice' } }), res);
    expect(res._status()).toBe(400);
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('shared preview cache', () => {
  it('CACHE HIT: serves the stored sample with NO OpenAI TTS call and NO gateway telemetry', async () => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    const globalFetch = mockOpenAiTtsFetch(200);
    vi.stubGlobal('fetch', globalFetch);
    // Cache HIT: download returns a non-empty blob.
    mockDownload.mockResolvedValue({ data: { arrayBuffer: async () => new ArrayBuffer(64) }, error: null });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status()).toBe(200);
    expect(res._sent()).toBeInstanceOf(Buffer);
    expect((res._sent() as Buffer).length).toBe(64);
    expect(globalFetch).not.toHaveBeenCalled();        // no paid TTS on a cache hit
    expect(gw.mockStartEvent).not.toHaveBeenCalled();  // no provider call → no telemetry
    expect(mockUpload).not.toHaveBeenCalled();          // nothing to write
  });

  it('CACHE MISS: generates once, then persists the sample to the shared cache', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200, 96));
    // Default beforeEach already sets a cache miss.
    const res = makeRes();
    await handler(makeReq({ body: { voice: 'coral', pace: 'normal' } }), res);

    expect(res._status()).toBe(200);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [path, , opts] = mockUpload.mock.calls[0] as [string, unknown, { contentType: string; upsert: boolean }];
    expect(path).toBe('voice-previews/gpt-4o-mini-tts/coral_normal.mp3'); // deterministic per (voice, pace)
    expect(opts).toMatchObject({ contentType: 'audio/mpeg', upsert: true });
  });

  it('a storage hiccup on read never breaks the preview (degrades to generation)', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    mockDownload.mockRejectedValue(new Error('storage down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._sent()).toBeInstanceOf(Buffer);
  });
});
