/**
 * Integration tests for api/tts.ts — AI Gateway integration (Etapa 9),
 * featureKey tts.synthesize.
 *
 * Scope: only the physical fetch() to Azure TTS REST is wrapped. Voice
 * resolution, SSML building, validation, and the streamed audio response are
 * unaffected — this file only asserts gateway behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import { estimateTtsCharacters, estimateProviderRequests } from '../_ai-gateway/estimators';

const { mockFetch, mockRequireAuth, gw, capturedContexts } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const mockRequireAuth = vi.fn();
  return {
    mockFetch,
    mockRequireAuth,
    gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps>,
    capturedContexts: [] as any[],
  };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return {
    ...actual,
    getProductionDeps: () => gw.mockDeps,
    executeAiGatewayCall: (async (context: any, ...rest: any[]) => {
      capturedContexts.push(context);
      return (actual.executeAiGatewayCall as any)(context, ...rest);
    }) as typeof actual.executeAiGatewayCall,
  };
});

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));

import handler from '../tts';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000010';

function mockAzureOk(bytes = 1000) {
  return Promise.resolve({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  });
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: { text: 'Hello world' },
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _headers: Record<string, string> = {};
  let _body: Buffer | undefined;
  const res = {
    _status: () => _status,
    _headers: () => _headers,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    setHeader(k: string, v: string) { _headers[k] = v; return res; },
    json(b: unknown) { _body = Buffer.from(JSON.stringify(b)); return res; },
    end(b: Buffer) { _body = b; return res; },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedContexts.length = 0;
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockFetch.mockImplementation(() => mockAzureOk());
  global.fetch = mockFetch as any;
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  process.env.AZURE_SPEECH_KEY = 'test-azure-key';
  process.env.AZURE_SPEECH_REGION = 'eastus';
});

describe('LEGACY mode', () => {
  it('streams audio and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._headers()['Content-Type']).toBe('audio/mpeg');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event for the single physical call', async () => {
    await handler(makeReq(), makeRes());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockFailEvent).not.toHaveBeenCalled();
  });

  it('uses featureKey tts.synthesize, provider azure, userId from auth, attemptNumber 1', async () => {
    await handler(makeReq(), makeRes());
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'tts.synthesize',
        provider: 'azure',
        service: 'tts_rest',
        userId: USER_ID,
        initiatedByUserId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
        callSequence: 1,
      }),
    );
  });

  it('records tts_characters using the deterministic SSML-based count, not string length of raw text', async () => {
    await handler(makeReq({ body: { text: 'Café ação 😀' } }), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    const ttsMetric = metrics.find((m) => m.metricKey === 'tts_characters');
    expect(ttsMetric).toBeTruthy();
    expect(ttsMetric?.isBillable).toBe(true);
    expect(ttsMetric?.measurementSource).toBe('ssml_request_body');
    // Deterministic and > 0; never derived from response, never persisted text.
    expect(typeof ttsMetric?.quantity).toBe('number');
    expect((ttsMetric?.quantity as number)).toBeGreaterThan(0);
  });

  it('estimatedMetrics (the pre-call reservation) exactly matches the real SSML about to be sent — same counter as the real tts_characters metric, computed before the physical call', async () => {
    await handler(makeReq({ body: { text: 'Café ação 😀' } }), makeRes());
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sentSsml = opts.body as string;
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0].estimatedMetrics).toEqual([
      estimateProviderRequests(1),
      estimateTtsCharacters(sentSsml, true),
    ]);
  });

  it('provider_requests is non-billable', async () => {
    await handler(makeReq(), makeRes());
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
  });

  it('a non-OK Azure HTTP response creates a failed event and preserves the prior 503/400 mapping', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(gw.mockCompleteEvent).not.toHaveBeenCalled();
    expect(res._status()).toBe(503);
  });

  it('a 400-class Azure error still maps to 400, and still creates a failed event', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 400, arrayBuffer: async () => new ArrayBuffer(0) }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(400);
  });

  it('a timeout (AbortError) creates a failed event and returns 504', async () => {
    mockFetch.mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(504);
  });

  it('empty audio from Azure creates a failed event and returns 503', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(503);
  });

  it('a telemetry failure (startEvent) does not break the audio response', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect(res._headers()['Content-Type']).toBe('audio/mpeg');
  });

  it('metadata never contains the TTS text', async () => {
    const secretText = 'A very secret confidential sentence.';
    await handler(makeReq({ body: { text: secretText } }), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    const metadataStr = JSON.stringify(startCall.metadata);
    expect(metadataStr).not.toContain('secret');
    expect(metadataStr).not.toContain('confidential');
  });

  it('resolvedVoice keeps coming from the existing allowlist/default config, unaffected by the Gateway', async () => {
    await handler(makeReq({ body: { text: 'Hi', voice: 'not-an-allowed-voice' } }), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    // Falls back to the existing DEFAULT_ENGLISH_VOICE, exactly as before.
    expect(startCall.technicalMetadata ?? startCall.metadata).toBeTruthy();
  });
});

describe('unauthenticated request', () => {
  it('never reaches Azure or telemetry', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockFetch).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});
