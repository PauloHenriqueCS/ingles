/**
 * Integration tests for api/pronunciation-training/[...slug].ts (token) —
 * AI Gateway integration (Etapa 9), featureKey pronunciation.get_azure_token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';

const { mockIssueToken, mockRequireAuth, gw } = vi.hoisted(() => {
  const mockIssueToken = vi.fn();
  const mockRequireAuth = vi.fn();
  return { mockIssueToken, mockRequireAuth, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});

vi.mock('../_azure-speech', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_azure-speech')>();
  return { ...actual, issueAzureSpeechToken: mockIssueToken };
});

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('openai', () => ({ default: vi.fn() }));

import handler from '../pronunciation-training/[...slug]';
import { AzureSpeechError } from '../_azure-speech';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000011';

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', url: '/api/pronunciation-training/token', headers: { authorization: 'Bearer test-token' }, body: {}, ...overrides };
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

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  mockIssueToken.mockResolvedValue({ token: 'ephemeral-token-xyz', region: 'eastus', expiresInSeconds: 540 });
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
});

describe('LEGACY mode', () => {
  it('returns the token and writes no telemetry', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('ephemeral-token-xyz');
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });
});

describe('OBSERVE mode', () => {
  beforeEach(() => {
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('records exactly one event, featureKey pronunciation.get_azure_token, provider azure, not billable', async () => {
    await handler(makeReq(), makeRes());
    expect(mockIssueToken).toHaveBeenCalledTimes(1);
    expect(gw.mockStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        featureKey: 'pronunciation.get_azure_token',
        provider: 'azure',
        service: 'speech_sts',
        userId: USER_ID,
        actorType: 'user',
        executionLocation: 'backend',
        attemptNumber: 1,
      }),
    );
    const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(metrics).toEqual([expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false })]);
  });

  it('never persists the token itself in metadata', async () => {
    await handler(makeReq(), makeRes());
    const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
    expect(JSON.stringify(startCall.metadata)).not.toContain('ephemeral-token-xyz');
  });

  it('an Azure error creates a failed event and preserves the previous error mapping', async () => {
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'timed out'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(gw.mockFailEvent).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(504);
    expect((res._body() as any).code).toBe('AZURE_SPEECH_TIMEOUT');
  });

  it('a telemetry failure does not prevent token issuance', async () => {
    gw.mockStartEvent.mockRejectedValue(new Error('DB down'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('ephemeral-token-xyz');
  });
});
