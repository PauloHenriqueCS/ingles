/**
 * api/pronunciation-training/[...slug].ts — dynamic per-plan daily-limit
 * enforcement for "Treino de Pronúncia" (generate-text get-or-create +
 * start/complete/fail). HTTP-handler-level coverage: entitlement gating,
 * request validation, and RPC-response-to-HTTP-response mapping.
 *
 * The effective daily limit is the plan capability
 * (pronunciation.evaluations.limit / .unlimited), resolved server-side and
 * passed to the RPCs — never hardcoded. True atomic concurrency-safety and
 * day-scoping (America/Sao_Paulo) are proven against the real DB/RPCs
 * separately; this file complements that with the request-shape contract a
 * mocked unit test is suited for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockGatewayDeps } from './_ai-gateway-test-helpers';
import { makeSpeechConfigFrom } from '../../src/test-utils/mock-speech-config';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../../src/domain/entitlements/entitlement-types';

const { mockRequireAuth, mockGetCurrentUserPlanEntitlements, mockIssueAzureSpeechToken, mockCreate, gw, svc } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockIssueAzureSpeechToken: vi.fn(),
  mockCreate: vi.fn(),
  gw: {} as ReturnType<typeof import('./_ai-gateway-test-helpers').createMockGatewayDeps>,
  // Holder for the SERVICE-role client mock. The quota RPCs
  // (create_pronunciation_training_text / reserve_pronunciation_training_assessment)
  // are service_role-only and now run via getCurriculumServiceClient().rpc(...).
  // We point that client at the SAME per-test client mock (same `.rpc` spy),
  // so the existing `expect(supabase.rpc)...` assertions keep working.
  svc: { current: null as any },
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

// Data-driven curriculum seam — generate-text composes its prompt from the DB
// curriculum (resolveActivityPrompt) instead of the removed hardcoded
// WORD_TARGETS/LEVEL_GUIDE/buildSystemPrompt. This suite asserts daily-limit /
// quota / RPC behavior, so the seam is stubbed to a fixed composed prompt
// (model null → handler falls back to AI_MODEL) and recordCurricularPractice is
// a best-effort no-op. Prompt composition is covered by
// api/__tests__/pronunciation-generate-text-gateway.test.ts.
vi.mock('../_curriculum/service-client', () => ({
  // Speech config resolves via the service client (active-path authority); the
  // hardened quota RPCs now run through it too. When a per-test client is wired
  // (svc.current) return it verbatim so `getCurriculumServiceClient().rpc` is the
  // SAME spy as `supabase.rpc` (and `.from` still serves speech config); else
  // fall back to a speech-config-only client.
  getCurriculumServiceClient: vi.fn(() => svc.current ?? { from: makeSpeechConfigFrom() }),
}));
vi.mock('../_curriculum/curriculum-runtime', () => ({
  resolveActivityPrompt: vi.fn().mockResolvedValue({
    system: 'Curriculum-composed system prompt.',
    user: 'Write the text now.',
    model: null,
    temperature: 0.9,
    subtopicKey: 'a1.greetings',
    versionId: 'version-1',
    languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' },
  }),
  // Active-path helpers used by the Speech resolver + the userLevel resolution.
  resolveActiveLearningLanguage: vi.fn(async () => 'en'),
  ensureUserCurriculum: vi.fn(async () => ({ currentLevelCode: 'B1', languageContext: { learningLanguage: 'en', interfaceLanguage: 'pt-BR' }, versionId: 'version-1' })),
  recordCurricularPracticeFromIdentity: vi.fn().mockResolvedValue({ recorded: true }),
  CurriculumConfigError: class CurriculumConfigError extends Error {},
}));

// The shared content library is covered by its own suite
// (shared-content-library.test.ts). Here it is a pass-through so these tests keep
// asserting the (unchanged) daily-limit / quota behaviour on a cache miss.
vi.mock('../_shared-content/get-or-create-shared-content', () => ({
  getOrCreateSharedContent: async (opts: any) => ({ itemId: 'shared-item-1', content: await opts.generateContent(), reused: false, audio: null }),
  levelCodeFromSubtopicKey: (k: string) => (typeof k === 'string' ? (k.split('.')[0] ?? '') : ''),
}));

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

// The generate-text handler issues, for pronunciation_training_sessions:
//   - active-row lookup: .select().eq(user).eq(date).neq('status','completed').maybeSingle()
//   - completed-count head query: .select('id',{count,head}).eq().eq().eq('status','completed')  (awaited)
//   - (when returning the completed state) latest-completed lookup:
//        .eq('status','completed').order('completed_at').limit(1).maybeSingle()
// The mock routes by which filters were applied on each fresh chain.
function makeSupabase(overrides: {
  activeRow?: Record<string, unknown> | null;
  completedCount?: number;
  latestCompleted?: Record<string, unknown> | null;
  rpcResults?: Record<string, unknown>;
} = {}) {
  const rpc = vi.fn((fnName: string) => {
    const result = overrides.rpcResults?.[fnName];
    return Promise.resolve(result !== undefined ? { data: result, error: null } : { data: null, error: null });
  });
  const client = {
    from: vi.fn((table: string) => {
      if (table === 'pronunciation_training_sessions') {
        const state = { neq: false, statusCompletedEq: false, ordered: false };
        const chain: any = {
          select: vi.fn(() => chain),
          eq: vi.fn((col?: string, val?: string) => { if (col === 'status' && val === 'completed') state.statusCompletedEq = true; return chain; }),
          neq: vi.fn(() => { state.neq = true; return chain; }),
          order: vi.fn(() => { state.ordered = true; return chain; }),
          limit: vi.fn(() => chain),
          maybeSingle: vi.fn(() => {
            if (state.neq) return Promise.resolve({ data: overrides.activeRow ?? null, error: null });
            if (state.ordered && state.statusCompletedEq) return Promise.resolve({ data: overrides.latestCompleted ?? null, error: null });
            return Promise.resolve({ data: null, error: null });
          }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: overrides.completedCount ?? 0, error: null }),
        };
        return chain;
      }
      // Data-driven Speech config resolution (token/start handlers) reads these.
      if (table === 'languages' || table === 'user_curriculum_preferences') {
        return speechFrom(table);
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
  // Wire this client as the service-role client too — the hardened quota RPCs
  // run via getCurriculumServiceClient().rpc, which must be the same spy.
  svc.current = client;
  return client;
}
const speechFrom = makeSpeechConfigFrom();

const activeTextRow = (o: Record<string, unknown> = {}) => ({
  id: 's1', level: 'B1', generated_text: 'Text.', status: 'text_generated',
  pronunciation_score: null, accuracy_score: null, fluency_score: null, completeness_score: null, prosody_score: null,
  recognized_text: null, words_json: null, raw_result_json: null, audio_duration_seconds: null, ...o,
});
const completedRow = (o: Record<string, unknown> = {}) => ({
  id: 's-done', level: 'B1', generated_text: 'Done text.', status: 'completed',
  pronunciation_score: 91.2, accuracy_score: 92, fluency_score: 90, completeness_score: 95, prosody_score: 88,
  recognized_text: 'done', words_json: [], raw_result_json: [], audio_duration_seconds: 10.5, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  svc.current = null;
  Object.assign(gw, createMockGatewayDeps());
  gw.resetDefaults();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AZURE_SPEECH_REGION = 'eastus';
  mockIssueAzureSpeechToken.mockResolvedValue({ token: 'azure-token', region: 'eastus', expiresInSeconds: 600 });
});

// ─── generate-text: daily get-or-create ───────────────────────────────────────

describe('generate-text — daily get-or-create', () => {
  it('1) first generation of the day calls the AI provider and persists via RPC with the dynamic limit params', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Fresh text.' } }] });
    const supabase = makeSupabase({
      activeRow: null, completedCount: 0,
      rpcResults: { create_pronunciation_training_text: { sessionId: 's1', text: 'Fresh text.', level: 'B1', status: 'text_generated', result: null, dailyCompleted: 0 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('text_generated');
    expect((res._body() as any).dailyLimit).toBe(3);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('create_pronunciation_training_text', expect.objectContaining({ p_user_id: USER_ID, p_start_new_round: false, p_effective_limit: 3, p_unlimited: false }));
  });

  it('2) an active (pending) session exists for today: returns it and never touches the AI provider', async () => {
    const supabase = makeSupabase({ activeRow: activeTextRow({ generated_text: 'Existing text.' }), completedCount: 0 });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).text).toBe('Existing text.');
    expect((res._body() as any).sessionId).toBe('s1');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('3) reload same day returns byte-identical text/session across repeated calls', async () => {
    const supabase = makeSupabase({ activeRow: activeTextRow({ generated_text: 'Stable text.' }), completedCount: 0 });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    const res1 = makeRes(); await handler(makeReq('generate-text'), res1);
    const res2 = makeRes(); await handler(makeReq('generate-text'), res2);

    expect((res1._body() as any).text).toBe((res2._body() as any).text);
    expect((res1._body() as any).sessionId).toBe((res2._body() as any).sessionId);
  });

  it('4) repeated generate-text calls (record/delete/re-record without submitting) never touch any RPC', async () => {
    const supabase = makeSupabase({ activeRow: activeTextRow(), completedCount: 0 });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith());

    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler(makeReq('generate-text'), res);
      expect((res._body() as any).status).toBe('text_generated');
    }
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('REPORTED BUG: entering and leaving the screen many times generates the daily text EXACTLY ONCE', async () => {
    // Reproduces the reported flow: open → get a text → leave → re-open (×N).
    // The first open (no active row) generates via AI + RPC; every subsequent
    // open must find the now-persisted active row and return it WITHOUT any new
    // AI generation — so 10 re-entries cost exactly ONE provider call.
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'The daily text.' } }] });

    // Stateful mock: no active row until the create RPC runs; afterwards the
    // active row exists (as the partial unique index guarantees in the real DB).
    let persistedActiveRow: Record<string, unknown> | null = null;
    const rpc = vi.fn((fnName: string) => {
      if (fnName === 'create_pronunciation_training_text') {
        persistedActiveRow = activeTextRow({ id: 's1', generated_text: 'The daily text.' });
        return Promise.resolve({ data: { sessionId: 's1', text: 'The daily text.', level: 'B1', status: 'text_generated', result: null, dailyCompleted: 0 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'pronunciation_training_sessions') {
          const state = { neq: false };
          const chain: any = {
            select: vi.fn(() => chain),
            eq: vi.fn(() => chain),
            neq: vi.fn(() => { state.neq = true; return chain; }),
            order: vi.fn(() => chain),
            limit: vi.fn(() => chain),
            maybeSingle: vi.fn(() => Promise.resolve({ data: state.neq ? persistedActiveRow : null, error: null })),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: 0, error: null }),
          };
          return chain;
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }),
      rpc,
    };
    svc.current = supabase; // service-role client shares this test's rpc spy
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const texts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      await handler(makeReq('generate-text'), res);
      texts.push((res._body() as any).text);
    }

    // Exactly one AI generation + one create RPC across all 10 entries.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.filter((c) => c[0] === 'create_pronunciation_training_text')).toHaveLength(1);
    // And every entry returned the SAME persisted text.
    expect(new Set(texts)).toEqual(new Set(['The daily text.']));
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

  it('unlimited plan, no session yet today: creates normally (limit=0 + unlimited=true never blocks)', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Fresh text.' } }] });
    const supabase = makeSupabase({
      activeRow: null, completedCount: 0,
      rpcResults: { create_pronunciation_training_text: { sessionId: 's1', text: 'Fresh text.', level: 'B1', status: 'text_generated', result: null, dailyCompleted: 0 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 0, evaluationsUnlimited: true }));

    const res = makeRes();
    await handler(makeReq('generate-text'), res);

    expect(res._status()).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('create_pronunciation_training_text', expect.objectContaining({ p_start_new_round: false, p_unlimited: true }));
  });
});

// ─── generate-text: dynamic per-plan daily limit (the core of this change) ─────
// Replaces the old "1/day fixed + unlimited-only reset" behavior: a limited
// plan can now start new rounds up to its configured N, and is blocked at N —
// the number always comes from pronunciation.evaluations.limit, never hardcoded.

describe('generate-text — dynamic per-plan daily limit', () => {
  it('limit 3, 1 completed, user starts a new round (forceNew): authorized, generates round 2 via AI + RPC', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Round 2.' } }] });
    const supabase = makeSupabase({
      activeRow: null, completedCount: 1, latestCompleted: completedRow(),
      rpcResults: { create_pronunciation_training_text: { sessionId: 's2', text: 'Round 2.', level: 'B1', status: 'text_generated', result: null, dailyCompleted: 1 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).text).toBe('Round 2.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('create_pronunciation_training_text', expect.objectContaining({ p_start_new_round: true, p_effective_limit: 3, p_unlimited: false }));
  });

  it('limit 3, already 3 completed, 4th round (forceNew): blocked 403 DAILY_LIMIT_REACHED, no AI call', async () => {
    const supabase = makeSupabase({ activeRow: null, completedCount: 3, latestCompleted: completedRow() });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
    expect((res._body() as any).dailyCompleted).toBe(3);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('limit 1 (trial/essential): 1 completed, forceNew blocked — a limited plan cannot exceed its own N', async () => {
    const supabase = makeSupabase({ activeRow: null, completedCount: 1, latestCompleted: completedRow() });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 1 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('the limit is taken from the plan, not hardcoded: raising it to 5 lets a 4th round through', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Round 4.' } }] });
    const supabase = makeSupabase({
      activeRow: null, completedCount: 3, latestCompleted: completedRow(),
      rpcResults: { create_pronunciation_training_text: { sessionId: 's4', text: 'Round 4.', level: 'B1', status: 'text_generated', result: null, dailyCompleted: 3 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 5 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('create_pronunciation_training_text', expect.objectContaining({ p_effective_limit: 5 }));
  });

  it('unlimited plan with many accumulated completed rounds still authorizes another (never compares a count)', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Round N.' } }] });
    const supabase = makeSupabase({
      activeRow: null, completedCount: 9, latestCompleted: completedRow(),
      rpcResults: { create_pronunciation_training_text: { sessionId: 'sN', text: 'Round N.', level: 'B1', status: 'text_generated', result: null, dailyCompleted: 9 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsUnlimited: true, evaluationsLimit: 0 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('create_pronunciation_training_text', expect.objectContaining({ p_unlimited: true }));
  });

  it('completed today, forceNew=false (plain reload) returns the saved result — never auto-discards or auto-advances a round', async () => {
    const supabase = makeSupabase({ activeRow: null, completedCount: 1, latestCompleted: completedRow({ pronunciation_score: 88 }) });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: false } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('completed');
    expect((res._body() as any).result.pronunciationScore).toBe(88);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('an active (in-progress) round: forceNew never interrupts it', async () => {
    const supabase = makeSupabase({ activeRow: activeTextRow({ generated_text: 'In-progress.', status: 'processing' }), completedCount: 0 });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsUnlimited: true }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('processing');
    expect((res._body() as any).text).toBe('In-progress.');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('concurrent race: pre-check passes but the RPC returns DAILY_LIMIT_REACHED (authoritative) → 403', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'Racy.' } }] });
    const supabase = makeSupabase({
      activeRow: null, completedCount: 2, latestCompleted: completedRow(),
      rpcResults: { create_pronunciation_training_text: { error: 'DAILY_LIMIT_REACHED', dailyCompleted: 3 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
    expect((res._body() as any).dailyCompleted).toBe(3);
  });

  it('a plan-entitlements load failure surfaces as a real 500 error, never a limit-reached block', async () => {
    const supabase = makeSupabase({ activeRow: null, completedCount: 1 });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockRejectedValue(new Error('supabase rpc timeout'));

    const res = makeRes();
    await handler(makeReq('generate-text', { body: { forceNew: true } }), res);

    expect(res._status()).toBe(500);
    expect((res._body() as any).code).toBe('INTERNAL_ERROR');
    expect((res._body() as any).code).not.toBe('DAILY_LIMIT_REACHED');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ─── start: reserve the official submission slot ──────────────────────────────

describe('start — reserve the daily official submission', () => {
  it('6) first official submission reserves successfully, returns a token, and passes the dynamic limit to the RPC', async () => {
    const supabase = makeSupabase({
      rpcResults: { reserve_pronunciation_training_assessment: { action: 'reserved', sessionId: 's1', referenceText: 'The text.', dailyCompleted: 1 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '11111111-1111-1111-1111-111111111111' } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).sessionId).toBe('s1');
    expect((res._body() as any).token).toBe('azure-token');
    expect((res._body() as any).referenceText).toBe('The text.');
    expect(supabase.rpc).toHaveBeenCalledWith('reserve_pronunciation_training_assessment', expect.objectContaining({ p_user_id: USER_ID, p_effective_limit: 3, p_unlimited: false }));
  });

  it('7) a submission past the limit is blocked with DAILY_LIMIT_REACHED (RPC enforces N atomically)', async () => {
    const supabase = makeSupabase({
      rpcResults: { reserve_pronunciation_training_assessment: { error: 'DAILY_LIMIT_REACHED', sessionId: 's1', dailyCompleted: 3 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('start', { body: { attemptId: '22222222-2222-2222-2222-222222222222' } }), res);

    expect(res._status()).toBe(403);
    expect((res._body() as any).code).toBe('DAILY_LIMIT_REACHED');
    expect(mockIssueAzureSpeechToken).not.toHaveBeenCalled();
  });

  it('8) a concurrent request holding the active slot gets ASSESSMENT_IN_PROGRESS (409)', async () => {
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
  it('5) accepts a recording at/under the plan limit, marks completed, and reports the updated daily count', async () => {
    const supabase = makeSupabase({
      rpcResults: { complete_pronunciation_training_assessment: { action: 'completed', dailyCompleted: 2 } },
    });
    mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase });
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWith({ maxRecordingSeconds: 60, evaluationsLimit: 3 }));

    const res = makeRes();
    await handler(makeReq('complete', { body: validResultBody({ audioDurationSeconds: 60 }), headers: { authorization: 'Bearer t', 'content-length': '500' } }), res);

    expect(res._status()).toBe(200);
    expect((res._body() as any).status).toBe('completed');
    expect((res._body() as any).dailyCompleted).toBe(2);
    expect((res._body() as any).dailyLimit).toBe(3);
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
      rpcResults: { complete_pronunciation_training_assessment: { action: 'completed', dailyCompleted: 1 } },
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

describe('fail — releases the slot without consuming a daily analysis', () => {
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
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });
});
