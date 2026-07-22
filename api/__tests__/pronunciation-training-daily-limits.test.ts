/**
 * api/pronunciation-training/[...slug].ts — daily plan-limit enforcement for
 * "Treino de Pronúncia" (start/complete/fail + generate-text's get-or-create
 * behavior). HTTP-handler-level coverage: entitlement gating, request
 * validation, and RPC-response-to-HTTP-response mapping.
 *
 * True concurrency-safety and day-scoping (America/Sao_Paulo) are proven
 * against the real database/RPCs separately — see the live RPC test run
 * during this task (25/25 passed: concurrent reserve calls, idempotent
 * retries, day rollover). This file complements that with the request-shape
 * contract a mocked unit test is actually suited for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockIssueAzureSpeechToken, mockCreate, gw } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockIssueAzureSpeechToken: vi.fn(),
  mockCreate: vi.fn(),
  gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps>,
}));

vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => gw.mockDeps };
});
vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));
vi.mock('../_azure-speech', () => ({
  issueAzureSpeechToken: mockIssueAzureSpeechToken,
  AzureSpeechError: class AzureSpeechError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
}));
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () { return { chat: { completions: { create: mockCreate } } }; }),
}));
vi.mock('../_rateLimit', () => ({ applyRateLimit: vi.fn().mockResolvedValue(true), RATE_LIMITS: {} }));

import handler from '../pronunciation-training/[...slug]';

const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000001';

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
  };
  return res;
}

function makeReq(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: `/api/pronunciation-training/${slug}`,
    headers: { authorization: 'Bearer test-token' },
    body: {},
    ...overrides,
  };
}

function permissiveLimit(period: 'day' | 'month' | 'request' | 'none' = 'day'): FeatureLimit {
  return { enabled: true, unlimited: false, limit: 1, consumed: 0, remaining: 1, period, state: 'available', canStart: true };
}

function entitlementsWith(overrides: { maxRecordingSeconds?: number; maxRecordingUnlimited?: boolean; evaluationsLimit?: number; evaluationsUnlimited?: boolean; pronunciationEnabled?: boolean } = {}): PlanEntitlementsSnapshot {
  const evaluations = permissiveLimit('day');
  evaluations.limit = overrides.evaluationsLimit ?? 1;
  evaluations.unlimited = overrides.evaluationsUnlimited ?? false;
  return {
    planId: 'plan-1', planCode: 'plano-teste-lojas', planName: 'Padrão', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit('day'), reviews: permissiveLimit('day'), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit('day') },
    pronunciation: {
      enabled: overrides.pronunciationEnabled ?? true,
      evaluations,
      maxRecordingSeconds: overrides.maxRecordingSeconds ?? 60,
      maxRecordingUnlimited: overrides.maxRecordingUnlimited ?? false,
    },
    conversation: { enabled: false, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

function makeSupabase(overrides: { existingSession?: Record<string, unknown> | null; rpcResults?: Record<string, unknown> } = {}) {
  const rpc = vi.fn((fnName: string) => {
    const result = overrides.rpcResults?.[fnName];
    return Promise.resolve(result !== undefined ? { data: result, error: null } : { data: null, error: null });
  });
  return {
    from: vi.fn((table: string) => {
      if (table === 'pronunciation_training_sessions') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: overrides.existingSession ?? null, error: null }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
    rpc,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AZURE_SPEECH_REGION = 'eastus';
  mockIssueAzureSpeechToken.mockResolvedValue({ token: 'azure-token', region: 'eastus', expiresInSeconds: 600 });
});

// ─── generate-text: daily get-or-create ───────────────────────────────────────

describe('generate-text — daily get-or-create', () => {
  it('1) first generation of the day calls the AI provider and persists via RPC', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Fresh text.' } }] });

    const supabase = makeSupabase({
      existingSession: null,
      rpcResults: { create_pronunciation_training_text: { sessionId: 's1', text: 'Fresh text.', level: 'B1', status: 'text_generated', result: null } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('text_generated');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('create_pronunciation_training_text', expect.objectContaining({ p_level: expect.any(String) }));
  });

  it('2) a session already exists for today: returns it and never touches the AI provider', async () => {
    const supabase = makeSupabase({
      existingSession: {
        id: 's1', level: 'B1', generated_text: 'Existing text.', status: 'text_generated',
        pronunciation_score: null, accuracy_score: null, fluency_score: null, completeness_score: null, prosody_score: null,
        recognized_text: null, words_json: null, raw_result_json: null, audio_duration_seconds: null,
      },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).text).toBe('Existing text.');
    expect((res._body() as any).sessionId).toBe('s1');
    expect(supabase.rpc).not.toHaveBeenCalled(); // no create_pronunciation_training_text call — no AI needed
  });

  it('3) reload same day returns byte-identical text/session across repeated calls', async () => {
    const existingRow = {
      id: 's1', level: 'A2', generated_text: 'Stable text across reloads.', status: 'text_generated',
      pronunciation_score: null, accuracy_score: null, fluency_score: null, completeness_score: null, prosody_score: null,
      recognized_text: null, words_json: null, raw_result_json: null, audio_duration_seconds: null,
    };
    const supabase = makeSupabase({ existingSession: existingRow });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res1 = makeRes();
    await handler(makeReq('generate-text'), res1);
    const res2 = makeRes();
    await handler(makeReq('generate-text'), res2);

    expect((res1._body() as any).text).toBe((res2._body() as any).text);
    expect((res1._body() as any).sessionId).toBe((res2._body() as any).sessionId);
  });

  it('9) reopening after completion returns the saved result, still no AI call', async () => {
    const supabase = makeSupabase({
      existingSession: {
        id: 's1', level: 'B1', generated_text: 'Completed text.', status: 'completed',
        pronunciation_score: 91.2, accuracy_score: 92, fluency_score: 90, completeness_score: 95, prosody_score: 88,
        recognized_text: 'completed text', words_json: [], raw_result_json: [], audio_duration_seconds: 10.5,
      },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('completed');
    expect((res._body() as any).result.pronunciationScore).toBe(91.2);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('4) repeated generate-text calls (simulating record/delete/re-record without ever submitting) never touch the reservation RPC — only /start can advance status past text_generated', async () => {
    const supabase = makeSupabase({
      existingSession: {
        id: 's1', level: 'B1', generated_text: 'Text.', status: 'text_generated',
        pronunciation_score: null, accuracy_score: null, fluency_score: null, completeness_score: null, prosody_score: null,
        recognized_text: null, words_json: null, raw_result_json: null, audio_duration_seconds: null,
      },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler(makeReq('generate-text'), res);
      expect((res._body() as any).status).toBe('text_generated');
    }
    // Neither create_pronunciation_training_text (no AI call needed — a row
    // already exists) nor reserve_pronunciation_training_assessment (that's
    // only called by /start) is ever invoked by repeated recording activity.
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('feature disabled blocks before any DB lookup', async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ pronunciationEnabled: false }));

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('FEATURE_DISABLED');
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

// ─── start: reserve the official submission slot ──────────────────────────────

describe('start — reserve the daily official submission', () => {
  it('6) first official submission reserves successfully and returns a token', async () => {
    const supabase = makeSupabase({
      rpcResults: { reserve_pronunciation_training_assessment: { action: 'reserved', sessionId: 's1', referenceText: 'The text.' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '11111111-1111-1111-1111-111111111111' } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).sessionId).toBe('s1');
    expect((res._body() as any).token).toBe('azure-token');
    expect((res._body() as any).referenceText).toBe('The text.');
  });

  it('7) second submission attempt the same day is blocked with DAILY_LIMIT_REACHED', async () => {
    const supabase = makeSupabase({
      rpcResults: { reserve_pronunciation_training_assessment: { error: 'DAILY_LIMIT_REACHED', sessionId: 's1' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '22222222-2222-2222-2222-222222222222' } }), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
    expect(mockIssueAzureSpeechToken).not.toHaveBeenCalled();
  });

  it('8) a concurrent request holding the slot gets ASSESSMENT_IN_PROGRESS (409)', async () => {
    const supabase = makeSupabase({
      rpcResults: { reserve_pronunciation_training_assessment: { error: 'ASSESSMENT_IN_PROGRESS', sessionId: 's1' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '33333333-3333-3333-3333-333333333333' } }), res);

    expect(res._status()).toBe(409);
    expect((res._body() as any).code).toBe('ASSESSMENT_IN_PROGRESS');
  });

  it('no text generated yet -> TEXT_NOT_GENERATED (409)', async () => {
    const supabase = makeSupabase({
      rpcResults: { reserve_pronunciation_training_assessment: { error: 'TEXT_NOT_GENERATED' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '44444444-4444-4444-4444-444444444444' } }), res);

    expect(res._status()).toBe(409);
    expect((res._body() as any).code).toBe('TEXT_NOT_GENERATED');
  });

  it('rejects a missing/invalid attemptId before touching the RPC', async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: 'not-a-uuid' } }), res);

    expect(res._status()).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('feature disabled blocks before reserving', async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ pronunciationEnabled: false }));

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '55555555-5555-5555-5555-555555555555' } }), res);

    expect(res._status()).toBe(403);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ─── complete: server-side recording-duration re-validation ──────────────────

function validResultBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: '66666666-6666-6666-6666-666666666666',
    attemptId: '77777777-7777-7777-7777-777777777777',
    result: {
      pronunciationScore: 90, accuracyScore: 90, fluencyScore: 90, completenessScore: 90, prosodyScore: 90,
      recognizedText: 'hello world', wordsJson: [], rawSegments: [], audioDurationSeconds: 30,
      ...overrides,
    },
  };
}

describe('complete — server-side recording duration re-validation (60s default plan)', () => {
  it('5) accepts a recording at/under the plan limit and marks the session completed', async () => {
    const supabase = makeSupabase({
      rpcResults: { complete_pronunciation_training_assessment: { action: 'completed' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ maxRecordingSeconds: 60 }));

    const res = makeRes();
    await handler(makeReq('complete', { body: validResultBody({ audioDurationSeconds: 60 }), headers: { authorization: 'Bearer t', 'content-length': '500' } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('completed');
  });

  it('blocks a recording over the plan limit (>60s) and releases the slot via fail RPC, never calling complete', async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ maxRecordingSeconds: 60 }));

    const res = makeRes();
    await handler(makeReq('complete', { body: validResultBody({ audioDurationSeconds: 61 }), headers: { authorization: 'Bearer t', 'content-length': '500' } }), res);

    expect(res._status()).toBe(413);
    expect((res._body() as any).code).toBe('RECORDING_TOO_LONG');
    expect(supabase.rpc).toHaveBeenCalledWith('fail_pronunciation_training_assessment', expect.objectContaining({ p_error_code: 'RESULT_INVALID' }));
    expect(supabase.rpc).not.toHaveBeenCalledWith('complete_pronunciation_training_assessment', expect.anything());
  });

  it('never applies the duration cap when the plan reports unlimited recording', async () => {
    const supabase = makeSupabase({
      rpcResults: { complete_pronunciation_training_assessment: { action: 'completed' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ maxRecordingUnlimited: true }));

    const res = makeRes();
    await handler(makeReq('complete', { body: validResultBody({ audioDurationSeconds: 999 }), headers: { authorization: 'Bearer t', 'content-length': '500' } }), res);

    expect(res._status()).toBe(200);
  });

  it('rejects a malformed result payload with 400, never reaching the RPC', async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('complete', { body: { sessionId: '1', attemptId: '2', result: {} }, headers: { authorization: 'Bearer t', 'content-length': '10' } }), res);

    expect(res._status()).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('maps ASSESSMENT_ALREADY_COMPLETED to a 409', async () => {
    const supabase = makeSupabase({
      rpcResults: { complete_pronunciation_training_assessment: { error: 'ASSESSMENT_ALREADY_COMPLETED' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('complete', { body: validResultBody(), headers: { authorization: 'Bearer t', 'content-length': '500' } }), res);

    expect(res._status()).toBe(409);
    expect((res._body() as any).code).toBe('ASSESSMENT_ALREADY_COMPLETED');
  });
});

// ─── fail ───────────────────────────────────────────────────────────────────

describe('fail — releases the slot without consuming the daily evaluation', () => {
  it('rejects an unrecognized error code', async () => {
    const supabase = makeSupabase();
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });

    const res = makeRes();
    await handler(makeReq('fail', { body: { sessionId: '11111111-1111-1111-1111-111111111111', attemptId: '22222222-2222-2222-2222-222222222222', code: 'NOT_A_REAL_CODE' } }), res);

    expect(res._status()).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a valid code calls the RPC and forwards its action', async () => {
    const supabase = makeSupabase({
      rpcResults: { fail_pronunciation_training_assessment: { action: 'failed_retryable' } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });

    const res = makeRes();
    await handler(makeReq('fail', { body: { sessionId: '11111111-1111-1111-1111-111111111111', attemptId: '22222222-2222-2222-2222-222222222222', code: 'AZURE_NO_MATCH' } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('failed_retryable');
  });
});

// ─── unauthenticated ──────────────────────────────────────────────────────────

describe('unauthenticated requests never reach any RPC', () => {
  // requireAuth is fully mocked here (as in every other gateway test in this
  // repo) — a bare mock resolving null does not itself write res.status the
  // way the real implementation does, so these assert on the absence of the
  // downstream side effect (AI call / entitlement lookup) rather than a
  // specific status code, matching the established convention in
  // pronunciation-generate-text-gateway.test.ts and pronunciation-token-gateway.test.ts.
  it('generate-text', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq('generate-text'), makeRes());
    expect(mockGetCurrentUserPlanEntitlements).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('start', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq('start', { body: { attemptId: '11111111-1111-1111-1111-111111111111' } }), makeRes());
    expect(mockGetCurrentUserPlanEntitlements).not.toHaveBeenCalled();
    expect(mockIssueAzureSpeechToken).not.toHaveBeenCalled();
  });

  it('complete', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq('complete', { body: validResultBody() }), makeRes());
    expect(mockGetCurrentUserPlanEntitlements).not.toHaveBeenCalled();
  });

  it('fail', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq('fail', { body: { sessionId: '1', attemptId: '2', code: 'AZURE_NO_MATCH' } }), makeRes());
    // requireAuth itself is the only thing that should have been consulted.
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });
});
