/**
 * Integration tests for api/pronunciation/[...slug].ts — AI Gateway
 * integration (Etapa 9):
 *   - pronunciation.start_assessment: normal backend-wrapped token issuance.
 *   - pronunciation.assess_text: the ai_provider_sessions bridge — session
 *     authorized at /start, completed/failed at /complete and /fail. The
 *     physical Azure call itself happens in the browser and is not
 *     exercised here (covered by pronunciationService.test.ts).
 *
 * Scope: requireAuth, the reserve/complete/fail RPCs, and their existing
 * response shapes are unaffected — this file only asserts Gateway/session
 * behavior layered additively on top.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockIssueToken, mockRequireAuth, mockGetCurrentUserPlanEntitlements, gw } = vi.hoisted(() => {
  const mockIssueToken = vi.fn();
  const mockRequireAuth = vi.fn();
  const mockGetCurrentUserPlanEntitlements = vi.fn();
  return { mockIssueToken, mockRequireAuth, mockGetCurrentUserPlanEntitlements, gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps> };
});

// Separate mock Supabase client standing in for getSharedServiceClient() —
// used only by the new session-transition code, distinct from the
// per-request `supabase` (requireAuth) used for the existing RPCs.
const { mockSessionsFrom, sessionsClient } = vi.hoisted(() => {
  const mockSessionsFrom = vi.fn();
  return { mockSessionsFrom, sessionsClient: { from: mockSessionsFrom } };
});

function makeSessionsChain(result: { data: { id: string } | null; error: unknown }) {
  const chain: any = {};
  for (const m of ['update', 'eq', 'in', 'select']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps, getSharedServiceClient: () => sessionsClient };
});

vi.mock('../_azure-speech', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_azure-speech')>();
  return { ...actual, issueAzureSpeechToken: mockIssueToken };
});

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));

vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

import handler from '../pronunciation/[...slug]';

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000012';
const OTHER_USER_ID = 'bbbbbbbb-0000-0000-0000-000000000099';
const TEXT_VERSION_ID = 'cccccccc-0000-0000-0000-000000000001';
const ATTEMPT_ID = 'dddddddd-0000-0000-0000-000000000001';
const ASSESSMENT_ID = 'eeeeeeee-0000-0000-0000-000000000001';
const GATEWAY_SESSION_ID = 'ffffffff-0000-0000-0000-000000000001';

const VALID_RESULT = {
  pronunciationScore: 88, accuracyScore: 90, fluencyScore: 85, completenessScore: 92, prosodyScore: 80,
  recognizedText: 'hello world', wordsJson: [{ word: 'hello' }], rawSegments: [{ x: 1 }],
  audioDurationSeconds: 12.5,
};

function makeSupabaseRpc(rpcResults: Record<string, unknown>) {
  return {
    rpc: vi.fn((name: string) => Promise.resolve({ data: rpcResults[name] ?? {}, error: null })),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: 'POST', url: '/api/pronunciation/start', headers: { authorization: 'Bearer test-token' }, body: {}, ...overrides };
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
  mockIssueToken.mockResolvedValue({ token: 'ephemeral-azure-token', region: 'eastus', expiresInSeconds: 540 });
  mockSessionsFrom.mockReturnValue(makeSessionsChain({ data: { id: GATEWAY_SESSION_ID }, error: null }));
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
});

// ── pronunciation.start_assessment ─────────────────────────────────────────

describe('POST /start — pronunciation.start_assessment', () => {
  const reserveOk = { action: 'created', assessmentId: ASSESSMENT_ID, referenceText: 'Read this aloud.' };

  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: makeSupabaseRpc({ reserve_pronunciation_assessment: reserveOk }) });
    process.env.AZURE_SPEECH_REGION = 'eastus';
  });

  it('LEGACY: issues the token, writes no telemetry, no gatewaySessionId in response', async () => {
    const res = makeRes();
    await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);
    expect(res._status()).toBe(200);
    expect((res._body() as any).token).toBe('ephemeral-azure-token');
    expect((res._body() as any).gatewaySessionId).toBeUndefined();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  describe('OBSERVE for pronunciation.start_assessment only (assess_text stays legacy)', () => {
    beforeEach(() => {
      gw.mockPolicyResolvePolicy.mockImplementation(async (ctx: any) =>
        ctx.featureKey === 'pronunciation.start_assessment'
          ? { gatewayMode: 'observe', runtimeStatus: 'enabled' }
          : { gatewayMode: 'legacy', runtimeStatus: 'enabled' },
      );
    });

    it('records one event for pronunciation.start_assessment, provider_requests only, not billable', async () => {
      const res = makeRes();
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);
      expect(gw.mockStartEvent).toHaveBeenCalledTimes(1);
      expect(gw.mockStartEvent).toHaveBeenCalledWith(
        expect.objectContaining({ featureKey: 'pronunciation.start_assessment', provider: 'azure', service: 'speech_sts', userId: USER_ID, attemptNumber: 1 }),
      );
      const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(metrics).toEqual([expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false })]);
      // assess_text itself is still legacy — no session authorized, no gatewaySessionId.
      expect((res._body() as any).gatewaySessionId).toBeUndefined();
    });
  });

  describe('OBSERVE for both start_assessment and assess_text', () => {
    beforeEach(() => {
      gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    });

    it('authorizes an ai_provider_sessions row and returns gatewaySessionId, additive and retrocompatible', async () => {
      const res = makeRes();
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).token).toBe('ephemeral-azure-token'); // existing fields unchanged
      expect((res._body() as any).gatewaySessionId).toBeTruthy();
      expect(gw.mockDeps.usageRepository.createProviderSession).toHaveBeenCalledWith(
        expect.objectContaining({ featureKey: 'pronunciation.assess_text', provider: 'azure', userId: USER_ID }),
      );
    });

    it('reserves audio_seconds using the server-authorized maximum duration ceiling, never a client-chosen value — /start receives no duration field from the client at all', async () => {
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), makeRes());
      const call = (gw.mockDeps.usageRepository.createProviderSession as any).mock.calls[0][0];
      // MAX_ASSESS_TEXT_DURATION_SECONDS in api/pronunciation/[...slug].ts —
      // the server's own generous upper bound, never derived from anything
      // the browser sent (the /start request body has no duration field to
      // begin with, so there is nothing client-supplied to trust or ignore).
      expect(call.metadata.estimatedAudioSecondsCeiling).toBe(900);
    });

    it('never persists the ephemeral token — only its SHA-256 fingerprint', async () => {
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), makeRes());
      const call = (gw.mockDeps.usageRepository.createProviderSession as any).mock.calls[0][0];
      expect(call.authorizationFingerprint).not.toBe('ephemeral-azure-token');
      expect(call.authorizationFingerprint).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
      expect(JSON.stringify(call)).not.toContain('ephemeral-azure-token');
    });

    it('a session-authorization failure never blocks token issuance (fail-open)', async () => {
      (gw.mockDeps.usageRepository.createProviderSession as any).mockRejectedValue(new Error('db down'));
      const res = makeRes();
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);
      expect(res._status()).toBe(200);
      expect((res._body() as any).token).toBe('ephemeral-azure-token');
      expect((res._body() as any).gatewaySessionId).toBeUndefined();
    });
  });

  it('an Azure token error still triggers the existing compensation RPC and error mapping', async () => {
    const { AzureSpeechError } = await import('../_azure-speech');
    mockIssueToken.mockRejectedValue(new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'timed out'));
    const rpc = makeSupabaseRpc({ reserve_pronunciation_assessment: reserveOk });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: rpc });
    const res = makeRes();
    await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);
    expect(res._status()).toBe(504);
    expect(rpc.rpc).toHaveBeenCalledWith('compensate_pronunciation_assessment', expect.anything());
  });
});

// ── pronunciation.assess_text — /complete bridge ────────────────────────────

describe('POST /complete — pronunciation.assess_text session bridge', () => {
  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabaseRpc({ complete_pronunciation_assessment: {} }),
    });
  });

  it('without gatewaySessionId: existing pedagogical response is completely unaffected', async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: '/api/pronunciation/complete', body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT } }),
      res,
    );
    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('completed');
    expect(mockSessionsFrom).not.toHaveBeenCalled();
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  describe('with gatewaySessionId, assess_text in observe', () => {
    beforeEach(() => {
      gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
    });

    it('completes the session and records one ai_usage_event with audio_seconds', async () => {
      const res = makeRes();
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        res,
      );
      expect(res._status()).toBe(200);
      expect((res._body() as any).status).toBe('completed'); // pedagogical response unchanged

      // Atomic, ownership-checked completion of the session row.
      const chain = mockSessionsFrom.mock.results[0].value;
      expect(chain.eq).toHaveBeenCalledWith('user_id', USER_ID);
      expect(chain.eq).toHaveBeenCalledWith('feature_key', 'pronunciation.assess_text');
      expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', duration_seconds: 12.5 }));

      expect(gw.mockStartEvent).toHaveBeenCalledWith(
        expect.objectContaining({ featureKey: 'pronunciation.assess_text', provider: 'azure', userId: USER_ID, executionLocation: 'frontend' }),
      );
      const metrics = gw.mockInsertMetrics.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'audio_seconds', quantity: 12.5, isBillable: true }));
      expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'provider_requests', quantity: 1, isBillable: false }));
    });

    it('a session that does not belong to this user (ownership mismatch) is a no-op — no event, no crash', async () => {
      mockSessionsFrom.mockReturnValue(makeSessionsChain({ data: null, error: null }));
      const res = makeRes();
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        res,
      );
      expect(res._status()).toBe(200); // pedagogical response still succeeds
      expect(gw.mockStartEvent).not.toHaveBeenCalled();
    });

    it('an already-terminal session (duplicate completion report) does not double-count — idempotent', async () => {
      // Atomic UPDATE ... WHERE status IN (authorized, connecting, active) matches
      // nothing once already completed — same no-op path as ownership mismatch.
      mockSessionsFrom.mockReturnValue(makeSessionsChain({ data: null, error: null }));
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        makeRes(),
      );
      expect(gw.mockDeps.usageRepository.startEvent).not.toHaveBeenCalled();
    });

    it('rejects a negative duration — no session transition, no event', async () => {
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: { ...VALID_RESULT, audioDurationSeconds: -1 }, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        makeRes(),
      );
      expect(mockSessionsFrom).not.toHaveBeenCalled();
      expect(gw.mockStartEvent).not.toHaveBeenCalled();
    });

    it('rejects a duration above the plausibility limit', async () => {
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: { ...VALID_RESULT, audioDurationSeconds: 999_999 }, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        makeRes(),
      );
      expect(mockSessionsFrom).not.toHaveBeenCalled();
      expect(gw.mockStartEvent).not.toHaveBeenCalled();
    });

    it('a telemetry failure never affects the pedagogical /complete response', async () => {
      gw.mockStartEvent.mockRejectedValue(new Error('db down'));
      const res = makeRes();
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        res,
      );
      expect(res._status()).toBe(200);
      expect((res._body() as any).status).toBe('completed');
    });

    it('metadata and the recorded event never contain recognizedText, wordsJson, or rawSegments', async () => {
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT, gatewaySessionId: GATEWAY_SESSION_ID },
        }),
        makeRes(),
      );
      const startCall = gw.mockStartEvent.mock.calls[0][0] as any;
      const payloadStr = JSON.stringify(startCall);
      expect(payloadStr).not.toContain('hello world');
      expect(payloadStr).not.toContain('rawSegments');
    });
  });

  it('an invalid RPC result (e.g. ATTEMPT_MISMATCH) is returned as before, gateway code never runs', async () => {
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabaseRpc({ complete_pronunciation_assessment: { error: 'ATTEMPT_MISMATCH' } }),
    });
    const res = makeRes();
    await handler(
      makeReq({
        url: '/api/pronunciation/complete',
        body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: VALID_RESULT, gatewaySessionId: GATEWAY_SESSION_ID },
      }),
      res,
    );
    expect(res._status()).toBe(409);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });
});

// ── pronunciation.assess_text — /fail bridge ────────────────────────────────

describe('POST /fail — pronunciation.assess_text session bridge', () => {
  beforeEach(() => {
    mockRequireAuth.mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabaseRpc({ fail_pronunciation_assessment: { action: 'marked_failed' } }),
    });
    gw.mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  });

  it('fails the session when gatewaySessionId is present, without creating any ai_usage_event', async () => {
    const res = makeRes();
    await handler(
      makeReq({
        url: '/api/pronunciation/fail',
        body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, code: 'AZURE_CANCELED', gatewaySessionId: GATEWAY_SESSION_ID },
      }),
      res,
    );
    expect(res._status()).toBe(200);
    const chain = mockSessionsFrom.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    // No physical-call event is invented for a failure we cannot prove reached Azure.
    expect(gw.mockStartEvent).not.toHaveBeenCalled();
  });

  it('without gatewaySessionId, existing behavior is fully unaffected', async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: '/api/pronunciation/fail', body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, code: 'AUDIO_EMPTY' } }),
      res,
    );
    expect(res._status()).toBe(200);
    expect(mockSessionsFrom).not.toHaveBeenCalled();
  });

  it('a telemetry failure never affects the /fail response', async () => {
    mockSessionsFrom.mockImplementation(() => { throw new Error('db down'); });
    const res = makeRes();
    await handler(
      makeReq({
        url: '/api/pronunciation/fail',
        body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, code: 'AZURE_CANCELED', gatewaySessionId: GATEWAY_SESSION_ID },
      }),
      res,
    );
    expect(res._status()).toBe(200);
  });
});

// ── Plan entitlements enforcement ──────────────────────────────────────────────

describe('plan entitlements enforcement', () => {
  describe('POST /start', () => {
    beforeEach(() => {
      mockRequireAuth.mockResolvedValue({
        userId: USER_ID,
        supabase: makeSupabaseRpc({ reserve_pronunciation_assessment: { action: 'created', assessmentId: ASSESSMENT_ID, referenceText: 'Read this aloud.' } }),
      });
      process.env.AZURE_SPEECH_REGION = 'eastus';
    });

    it('returns 403 FEATURE_DISABLED and never reserves a slot when pronunciation is off', async () => {
      const entitlements = permissiveEntitlements();
      entitlements.pronunciation.enabled = false;
      mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

      const res = makeRes();
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);

      expect(res._status()).toBe(403);
      expect((res._body() as any).code).toBe('FEATURE_DISABLED');
      expect(mockIssueToken).not.toHaveBeenCalled();
    });

    it('returns 403 DAILY_LIMIT_REACHED and never issues a token once the daily evaluation limit is exhausted', async () => {
      const entitlements = permissiveEntitlements();
      entitlements.pronunciation.evaluations = { enabled: true, unlimited: false, limit: 5, consumed: 5, remaining: 0, period: 'day', state: 'daily_limit_reached', canStart: false };
      mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

      const res = makeRes();
      await handler(makeReq({ url: '/api/pronunciation/start', body: { textVersionId: TEXT_VERSION_ID, attemptId: ATTEMPT_ID } }), res);

      expect(res._status()).toBe(403);
      expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
      expect(mockIssueToken).not.toHaveBeenCalled();
    });
  });

  describe('POST /complete', () => {
    it('rejects a recording over the plan max, releases the slot via fail_pronunciation_assessment, and never persists the result', async () => {
      const entitlements = permissiveEntitlements();
      entitlements.pronunciation.maxRecordingSeconds = 30;
      entitlements.pronunciation.maxRecordingUnlimited = false;
      mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

      const rpc = makeSupabaseRpc({
        complete_pronunciation_assessment: {},
        fail_pronunciation_assessment: { action: 'marked_failed' },
      });
      mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: rpc });

      const res = makeRes();
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: { ...VALID_RESULT, audioDurationSeconds: 45 } },
        }),
        res,
      );

      expect(res._status()).toBe(413);
      expect((res._body() as any).code).toBe('RECORDING_TOO_LONG');
      expect(rpc.rpc).toHaveBeenCalledWith('fail_pronunciation_assessment', expect.objectContaining({ p_assessment_id: ASSESSMENT_ID, p_attempt_id: ATTEMPT_ID, p_error_code: 'RESULT_INVALID' }));
      expect(rpc.rpc).not.toHaveBeenCalledWith('complete_pronunciation_assessment', expect.anything());
    });

    it('allows a recording within the plan max through to complete_pronunciation_assessment', async () => {
      const entitlements = permissiveEntitlements();
      entitlements.pronunciation.maxRecordingSeconds = 30;
      entitlements.pronunciation.maxRecordingUnlimited = false;
      mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);

      const rpc = makeSupabaseRpc({ complete_pronunciation_assessment: {} });
      mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: rpc });

      const res = makeRes();
      await handler(
        makeReq({
          url: '/api/pronunciation/complete',
          body: { assessmentId: ASSESSMENT_ID, attemptId: ATTEMPT_ID, result: { ...VALID_RESULT, audioDurationSeconds: 12.5 } },
        }),
        res,
      );

      expect(res._status()).toBe(200);
      expect(rpc.rpc).toHaveBeenCalledWith('complete_pronunciation_assessment', expect.anything());
    });
  });
});
