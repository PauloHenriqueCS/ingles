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

const { mockRequireAuth, gw } = vi.hoisted(() => {
  const mockRequireAuth = vi.fn();
  return { mockRequireAuth, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
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
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  process.env.OPENAI_API_KEY = 'sk-test-key';
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

  it('records exactly one physical call for conversation.preview_tts, provider openai, model tts-1', async () => {
    vi.stubGlobal('fetch', mockOpenAiTtsFetch(200));
    await handler(makeReq(), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'conversation.preview_tts',
        provider: 'openai',
        service: 'audio.speech',
        model: 'tts-1',
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
    expect(sentBody.model).toBe('tts-1');
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
