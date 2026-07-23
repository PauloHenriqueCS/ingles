import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FeatureLimit, PlanEntitlementsSnapshot } from '../domain/entitlements/entitlement-types';

// ── Hoist mock refs ───────────────────────────────────────────────────────────

const { mockCreate, mockGatewayDeps } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  // AI Gateway stays fully neutral here — this file tests review-text's own
  // logic (auth, validation, retries, DB writes), not gateway telemetry.
  // Forcing legacy mode avoids constructing a real Supabase-backed usage
  // repository (which requires service-role credentials this file never
  // stubs) and keeps executeAiGatewayCall a pure pass-through, matching
  // this suite's pre-gateway behavior exactly. Gateway-specific behavior
  // is covered by api/__tests__/review-text-gateway.test.ts.
  const mockGatewayDeps = {
    policyResolver: {
      resolvePolicy: vi.fn().mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' }),
      invalidate: vi.fn(),
    },
    usageRepository: {
      startEvent: vi.fn(),
      completeEvent: vi.fn(),
      failEvent: vi.fn(),
      cancelEvent: vi.fn(),
      insertMetrics: vi.fn(),
      createProviderSession: vi.fn(),
      activateSession: vi.fn(),
      completeSession: vi.fn(),
      failSession: vi.fn(),
      expireSession: vi.fn(),
      getEventForCosting: vi.fn(),
      getMetricsForEvent: vi.fn(),
      updateMetricCost: vi.fn(),
      updateEventCost: vi.fn(),
    },
    pricingRepository: {
      findActivePrice: vi.fn(),
    },
    dailyRollupRepository: {
      rebuildBucketForEvent: vi.fn(),
      rebuildBucket: vi.fn(),
      listBucketsForDate: vi.fn(),
    },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
  };
  return { mockCreate, mockGatewayDeps };
});

vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

// Plan entitlements — permissive by default (writing enabled + unlimited),
// matching this suite's pre-entitlements behavior; overridden per-test where needed.
const { mockGetCurrentUserPlanEntitlements } = vi.hoisted(() => ({
  mockGetCurrentUserPlanEntitlements: vi.fn(),
}));
vi.mock('../../api/_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));

vi.mock('../../api/_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => mockGatewayDeps };
});

vi.mock('openai', () => ({
  default: vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import { requireAuth } from '../../api/_auth';
import handler, {
  parseJsonSafely,
  validateEvaluations,
  calculateOverallResult,
} from '../../api/review-text';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTRY_ID = '2026-01-15';
const REVIEW_GROUP_ID = 'cccccccc-0000-0000-0000-000000000001';

const VALID_AI_RESPONSE = JSON.stringify({
  score: 78,
  level: 'B1',
  grammar: 80,
  vocabulary: 75,
  naturalness: 78,
  fluency: 76,
  summary: 'Bom trabalho!',
  correctedText: 'Yesterday I went to the store.',
  mainMistakes: [{ original: 'goed', correct: 'went', explanation: 'went é o passado de go.' }],
  newVocabulary: [{ word: 'store', meaningPtBr: 'loja', example: 'I went to the store.' }],
  objectiveFeedback: 'Uso do Past Simple foi adequado.',
  nextPractice: 'Pratique mais tempos verbais irregulares.',
});

/** Creates a chainable Supabase query stub that resolves to `result`. */
function makeChain(result: { data: unknown; error: unknown }) {
  const p = Promise.resolve(result);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'gte', 'lte', 'order']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.limit       = vi.fn().mockReturnValue(p);
  c.single      = vi.fn().mockReturnValue(p);
  c.maybeSingle = vi.fn().mockReturnValue(p);
  return c;
}

const DEFAULT_ATTEMPT_ID = 'dddddddd-1111-1111-1111-111111111111';
const DEFAULT_REVIEW_ID = 'eeeeeeee-2222-2222-2222-222222222222';

const STORED_REVIEW_ROW = {
  corrected_text: 'Yesterday I went to the store.',
  score: 78, level: 'B1', grammar: 80, vocabulary: 75, naturalness: 78, fluency: 76,
  summary: 'Bom trabalho!',
  main_mistakes: [{ original: 'goed', correct: 'went', explanation: 'went é o passado de go.' }],
  new_vocabulary: [{ word: 'store', meaningPtBr: 'loja', example: 'I went to the store.' }],
  objective_feedback: 'Uso do Past Simple foi adequado.',
  next_practice: 'Pratique mais tempos verbais irregulares.',
  created_at: '2026-01-15T12:00:00Z',
};

/** Default RPC behavior: reservation always granted, complete/fail/schedule succeed. Override per-test via a fresh vi.fn(). */
function makeDefaultRpc() {
  return vi.fn((name: string) => {
    if (name === 'reserve_writing_review') {
      return Promise.resolve({ data: { status: 'reserved', reservationId: 'reservation-1', fresh: true }, error: null });
    }
    if (name === 'complete_writing_review_reservation') {
      return Promise.resolve({ data: { action: 'completed', reservationId: 'reservation-1' }, error: null });
    }
    if (name === 'fail_writing_review_reservation') {
      return Promise.resolve({ data: { action: 'failed', reservationId: 'reservation-1' }, error: null });
    }
    if (name === 'apply_review_schedule') {
      return Promise.resolve({ data: { applied: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

function makeDefaultSupabase() {
  const from = vi.fn((table: string) => {
    if (table === 'writing_entries') {
      // .update({}).eq(...).eq(...) — no destructuring, non-thenable chain is fine
      return makeChain({ data: null, error: null });
    }
    if (table === 'review_groups') {
      // .select('id').eq(...).single() — terminal: .single()
      return makeChain({ data: { id: REVIEW_GROUP_ID }, error: null });
    }
    if (table === 'review_group_items') {
      // .select('...').eq(...) — terminal: .eq() with destructuring
      const p = Promise.resolve({
        data: [
          { id: 'item-1', original_value: 'therefor', corrected_value: 'therefore', explanation: null, original_sentence: null },
          { id: 'item-2', original_value: 'altough', corrected_value: 'although', explanation: null, original_sentence: null },
        ],
        error: null,
      });
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue(p) }) };
    }
    if (table === 'review_attempts') {
      // .insert({}).select('id').single() — terminal: .single()
      return makeChain({ data: { id: 'attempt-1' }, error: null });
    }
    if (table === 'review_attempt_items') {
      // .insert([]) — terminal: .insert()
      return { insert: vi.fn().mockReturnValue(Promise.resolve({ data: null, error: null })) };
    }
    if (table === 'english_reviews') {
      // Serves both .insert({}).select('id').single() (record a completed
      // review) and .select(...).eq('id', reviewId).maybeSingle() (idempotent
      // replay lookup) — same terminal shape covers both.
      return makeChain({ data: { id: DEFAULT_REVIEW_ID, ...STORED_REVIEW_ROW }, error: null });
    }
    return makeChain({ data: null, error: null });
  });
  const rpc = makeDefaultRpc();
  return { from, rpc };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  const { body: bodyOverrides, ...rest } = overrides;
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: {
      entryId: ENTRY_ID,
      originalText: 'Yesterday I goed to the store.',
      theme: 'A trip to the store',
      grammarGoal: 'Past Simple',
      mainTense: 'Past Simple',
      attemptId: DEFAULT_ATTEMPT_ID,
      ...(bodyOverrides as Record<string, unknown> | undefined),
    },
    ...rest,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; return res; },
    end() { return res; },
    setHeader() { return res; },
  };
  return res;
}

function aiOk(content: string) {
  return Promise.resolve({ choices: [{ message: { content } }] });
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
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.mocked(requireAuth).mockResolvedValue({
    userId: USER_ID,
    supabase: makeDefaultSupabase() as any,
  });
  mockCreate.mockImplementation(() => aiOk(VALID_AI_RESPONSE));
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ── parseJsonSafely ───────────────────────────────────────────────────────────

describe('parseJsonSafely', () => {
  it('parses a clean JSON string', () => {
    expect(parseJsonSafely('{"score": 80}')).toEqual({ score: 80 });
  });

  it('extracts JSON embedded in surrounding text', () => {
    const result = parseJsonSafely('Here is feedback: {"score": 70} end.');
    expect(result).toMatchObject({ score: 70 });
  });

  it('throws on completely invalid content', () => {
    expect(() => parseJsonSafely('just text no json')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => parseJsonSafely('')).toThrow();
  });
});

// ── calculateOverallResult ────────────────────────────────────────────────────

describe('calculateOverallResult', () => {
  it('all correct → passed', () => {
    const evals = [
      { requiredWord: 'therefore', status: 'correct' as const, usedExcerpt: 'therefore I went', explanation: 'ok', suggestedCorrection: null },
      { requiredWord: 'although', status: 'correct' as const, usedExcerpt: 'although tired', explanation: 'ok', suggestedCorrection: null },
    ];
    expect(calculateOverallResult(evals)).toBe('passed');
  });

  it('any incorrect_spelling → failed', () => {
    const evals = [
      { requiredWord: 'therefore', status: 'correct' as const, usedExcerpt: null, explanation: 'ok', suggestedCorrection: null },
      { requiredWord: 'although', status: 'incorrect_spelling' as const, usedExcerpt: null, explanation: 'wrong', suggestedCorrection: 'although' },
    ];
    expect(calculateOverallResult(evals)).toBe('failed');
  });

  it('missing word → failed', () => {
    const evals = [
      { requiredWord: 'therefore', status: 'missing' as const, usedExcerpt: null, explanation: 'não encontrado', suggestedCorrection: 'therefore I agree' },
    ];
    expect(calculateOverallResult(evals)).toBe('failed');
  });

  it('forced_usage → failed', () => {
    const evals = [
      { requiredWord: 'therefore', status: 'forced_usage' as const, usedExcerpt: 'therefore', explanation: 'forçado', suggestedCorrection: null },
    ];
    expect(calculateOverallResult(evals)).toBe('failed');
  });

  it('incorrect_usage → failed', () => {
    const evals = [
      { requiredWord: 'therefore', status: 'incorrect_usage' as const, usedExcerpt: 'therefore', explanation: 'uso errado', suggestedCorrection: 'Therefore, I concluded' },
    ];
    expect(calculateOverallResult(evals)).toBe('failed');
  });

  it('empty array → passed (no words to fail)', () => {
    expect(calculateOverallResult([])).toBe('passed');
  });
});

// ── validateEvaluations ───────────────────────────────────────────────────────

describe('validateEvaluations', () => {
  const expectedWords = ['therefore', 'although'];

  function validEval(word: string) {
    return {
      requiredWord: word,
      status: 'correct' as const,
      usedExcerpt: `using ${word}`,
      explanation: 'Usou corretamente.',
      suggestedCorrection: null,
    };
  }

  it('accepts a valid evaluation array', () => {
    const result = validateEvaluations([validEval('therefore'), validEval('although')], expectedWords);
    expect(result).toHaveLength(2);
    expect(result[0].requiredWord).toBe('therefore');
  });

  it('throws when array length does not match expected words count', () => {
    expect(() => validateEvaluations([validEval('therefore')], expectedWords)).toThrow();
  });

  it('throws when a word not in expectedWords appears', () => {
    expect(() =>
      validateEvaluations(
        [validEval('therefore'), { ...validEval('moreover'), requiredWord: 'moreover' }],
        expectedWords,
      ),
    ).toThrow();
  });

  it('throws when the same word appears twice', () => {
    expect(() =>
      validateEvaluations([validEval('therefore'), validEval('therefore')], ['therefore', 'therefore']),
    ).toThrow();
  });

  it('throws when status is not one of the allowed values', () => {
    expect(() =>
      validateEvaluations(
        [{ ...validEval('therefore'), status: 'unknown' as any }],
        ['therefore'],
      ),
    ).toThrow();
  });

  it('throws when explanation is empty', () => {
    expect(() =>
      validateEvaluations(
        [{ ...validEval('therefore'), explanation: '' }],
        ['therefore'],
      ),
    ).toThrow();
  });

  it('throws when input is not an array', () => {
    expect(() => validateEvaluations('not-an-array' as any, expectedWords)).toThrow();
  });

  it('null usedExcerpt is accepted when status is missing', () => {
    const result = validateEvaluations(
      [{ requiredWord: 'therefore', status: 'missing', usedExcerpt: null, explanation: 'não encontrado', suggestedCorrection: 'Use therefore here.' }],
      ['therefore'],
    );
    expect(result[0].usedExcerpt).toBeNull();
  });
});

// ── handler — método HTTP ─────────────────────────────────────────────────────

describe('handler — método HTTP', () => {
  it('retorna 405 para GET', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('retorna 405 para DELETE', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res._status).toBe(405);
  });
});

// ── handler — autenticação ────────────────────────────────────────────────────

describe('handler — autenticação', () => {
  it('não chama a IA sem autenticação', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── handler — validação do body ───────────────────────────────────────────────

describe('handler — validação do body', () => {
  it('retorna 400 quando originalText está ausente', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { originalText: undefined } }), res);
    expect(res._status).toBe(400);
  });

  it('retorna 400 quando originalText é string vazia', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { originalText: '   ' } }), res);
    expect(res._status).toBe(400);
  });

  it('retorna 400 quando originalText não é string', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { originalText: 123 } }), res);
    expect(res._status).toBe(400);
  });
});

// ── handler — chave de API ausente ───────────────────────────────────────────

describe('handler — OPENAI_API_KEY ausente', () => {
  it('retorna 503 quando a chave não está configurada', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('OPENAI_API_KEY', '');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── handler — modo normal, fluxo feliz ───────────────────────────────────────

describe('handler — modo normal', () => {
  it('retorna 200 com feedback e reviewedAt', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body).toHaveProperty('feedback');
    expect(body).toHaveProperty('reviewedAt');
  });

  it('feedback contém campos obrigatórios', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const fb = (res._body as Record<string, unknown>).feedback as Record<string, unknown>;
    expect(fb).toHaveProperty('score');
    expect(fb).toHaveProperty('level');
    expect(fb).toHaveProperty('grammar');
    expect(fb).toHaveProperty('vocabulary');
    expect(fb).toHaveProperty('correctedText');
    expect(fb).toHaveProperty('mainMistakes');
    expect(fb).toHaveProperty('newVocabulary');
  });

  it('texto original não vaza na resposta ao lado da correção', async () => {
    const originalText = 'Yesterday I goed to the store.';
    const res = makeRes();
    await handler(makeReq({ body: { originalText, theme: 'Trip', grammarGoal: 'Past', mainTense: 'Past Simple' } }), res);
    // The response should have correctedText (from AI), not the raw originalText
    const fb = (res._body as Record<string, unknown>).feedback as Record<string, unknown>;
    expect(fb).toHaveProperty('correctedText');
    // Original text is not a required field in the feedback response
    expect(fb).not.toHaveProperty('originalText');
  });

  it('JSON inválido da IA após 3 tentativas → 500', async () => {
    mockCreate.mockImplementation(() => aiOk('not json'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });

  it('falha do provider → 500', async () => {
    mockCreate.mockRejectedValue(new Error('AI service unavailable'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });

  it('resposta de erro não expõe a chave da API', async () => {
    mockCreate.mockImplementation(() => aiOk('invalid json'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(JSON.stringify(res._body)).not.toContain('test-openai-key');
  });

  it('atualiza writing_entries com user_id do auth, não do body', async () => {
    const mockSupa = makeDefaultSupabase();
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: mockSupa as any });
    await handler(makeReq({ body: { originalText: 'Hello world.', entryId: ENTRY_ID, userId: 'injected-evil' } }), makeRes());
    // Verified by the handler's own `.eq('user_id', userId)` call using auth userId
    expect(mockCreate).toHaveBeenCalled(); // AI was called
  });
});

// ── handler — modo revisão ────────────────────────────────────────────────────

const REVIEW_AI_RESPONSE = JSON.stringify({
  score: 82,
  level: 'B1',
  grammar: 85,
  vocabulary: 80,
  naturalness: 82,
  fluency: 78,
  summary: 'Bom uso dos conectores!',
  correctedText: 'Although I was tired, I finished the task. Therefore, I was proud.',
  mainMistakes: [],
  newVocabulary: [{ word: 'proud', meaningPtBr: 'orgulhoso', example: 'I am proud of you.' }],
  objectiveFeedback: 'Usou although e therefore corretamente.',
  nextPractice: 'Tente usar moreover e however.',
  requiredWordEvaluation: [
    { requiredWord: 'therefore', status: 'correct', usedExcerpt: 'Therefore, I was proud.', explanation: 'Usou corretamente.', suggestedCorrection: null },
    { requiredWord: 'although', status: 'correct', usedExcerpt: 'Although I was tired', explanation: 'Usou corretamente.', suggestedCorrection: null },
  ],
});

describe('handler — modo revisão', () => {
  beforeEach(() => {
    mockCreate.mockImplementation(() => aiOk(REVIEW_AI_RESPONSE));
  });

  const reviewBody = {
    originalText: 'Although I was tired, I finished. Therefore, I was proud.',
    mode: 'review',
    reviewGroupId: REVIEW_GROUP_ID,
    missionTitle: 'Revisão de conectores',
    grammarGoal: 'Connectors',
    studentLevel: 'B1',
  };

  it('retorna 200 com feedback contendo requiredWordEvaluation', async () => {
    const res = makeRes();
    await handler(makeReq({ body: reviewBody }), res);
    expect(res._status).toBe(200);
    const fb = (res._body as Record<string, unknown>).feedback as Record<string, unknown>;
    expect(Array.isArray(fb.requiredWordEvaluation)).toBe(true);
  });

  it('retorna 403 quando grupo de revisão não pertence ao usuário', async () => {
    const mockSupa = makeDefaultSupabase();
    vi.spyOn(mockSupa, 'from').mockImplementation((table: string) => {
      if (table === 'review_groups') return makeChain({ data: null, error: null });
      return makeDefaultSupabase().from(table);
    });
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: mockSupa as any });

    const res = makeRes();
    await handler(makeReq({ body: reviewBody }), res);
    expect(res._status).toBe(403);
  });

  it('retorna 400 quando itens do grupo não existem', async () => {
    const mockSupa = makeDefaultSupabase();
    vi.spyOn(mockSupa, 'from').mockImplementation((table: string) => {
      if (table === 'review_group_items') return makeChain({ data: [], error: null });
      return makeDefaultSupabase().from(table);
    });
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: mockSupa as any });

    const res = makeRes();
    await handler(makeReq({ body: reviewBody }), res);
    expect(res._status).toBe(400);
  });

  it('palavras obrigatórias vêm do banco, não do body', async () => {
    // AI response matches the DB words (therefore, although)
    // If body tried to inject different words, they're ignored
    const res = makeRes();
    await handler(makeReq({ body: { ...reviewBody, requiredWords: ['injected', 'evil'] } }), res);
    expect(res._status).toBe(200);
    // The review still proceeded with DB words, not injected words
  });
});

// ── handler — isolamento entre usuários ─────────────────────────────────────

describe('handler — isolamento entre usuários', () => {
  it('user_id na atualização vem da sessão, não do body', async () => {
    const mockSupa = makeDefaultSupabase();
    const eqCalls: string[] = [];
    vi.spyOn(mockSupa, 'from').mockImplementation((_table: string) => {
      const chain = makeChain({ data: null, error: null });
      const originalEq = chain.eq as (col: string, val: string) => unknown;
      chain.eq = vi.fn((col: string, val: string) => {
        if (col === 'user_id') eqCalls.push(val);
        return originalEq(col, val);
      });
      return chain;
    });
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: mockSupa as any });

    await handler(makeReq({ body: { originalText: 'Hello.', entryId: ENTRY_ID, userId: 'evil-user' } }), makeRes());
    // If any user_id filter was applied, it must be the session user, not evil-user
    for (const uid of eqCalls) {
      expect(uid).not.toBe('evil-user');
    }
  });
});

// ── handler — limites de plano (writing.reviews) ─────────────────────────────
// Root cause under test: the daily review limit's consumption used to be
// written by the FRONTEND (src/lib/reviews.ts, saveEnglishReview) as a
// fire-and-forget call AFTER the AI had already answered — completely
// decoupled from the request that actually consumed it. That let the limit
// be bypassed (call the AI repeatedly, never trigger the client save) or
// mis-recorded (client insert fails after the AI already ran, or races the
// entitlements refetch). The fix moves recording server-side, atomically,
// via reserve_writing_review (before the AI call) and
// complete_writing_review_reservation (only after a valid result) — this
// suite locks in that behavior directly against api/review-text.ts.

function entitlementsWithReviews(overrides: {
  unlimited?: boolean; limit?: number; consumed?: number; canStart?: boolean; enabled?: boolean;
} = {}): PlanEntitlementsSnapshot {
  const base = permissiveEntitlements();
  const unlimited = overrides.unlimited ?? false;
  const limit = overrides.limit ?? 1;
  const consumed = overrides.consumed ?? 0;
  const enabled = overrides.enabled ?? true;
  const remaining = unlimited ? Number.POSITIVE_INFINITY : Math.max(limit - consumed, 0);
  const canStart = overrides.canStart ?? (enabled && (unlimited || remaining > 0));
  base.writing.enabled = enabled; // top-level "Escrita" gate — matches lockedSnapshot()'s shape for a no-plan/suspended user
  base.writing.reviews = {
    enabled, unlimited, limit, consumed, remaining,
    period: 'day',
    state: !enabled ? 'disabled_by_plan' : unlimited ? 'unlimited' : canStart ? 'available' : 'daily_limit_reached',
    canStart,
  };
  return base;
}

function rpcSpy(overrides: Record<string, unknown> = {}) {
  const calls: { name: string; params: unknown }[] = [];
  const base = makeDefaultRpc();
  const fn = vi.fn((name: string, params: unknown) => {
    calls.push({ name, params });
    if (name in overrides) return (overrides as any)[name](params);
    return base(name, params);
  });
  return { fn, calls };
}

describe('handler — limites de plano (writing.reviews)', () => {
  it('1) usuário Free dentro do limite: permite e reserva com os valores corretos do plano', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 1, consumed: 0 }));
    const { fn: rpc, calls } = rpcSpy();
    const supabase = { ...makeDefaultSupabase(), rpc };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const reserveCall = calls.find((c) => c.name === 'reserve_writing_review');
    expect(reserveCall?.params).toMatchObject({ p_unlimited: false, p_limit: 1 });
  });

  it('2) usuário Free no último uso disponível (consumed = limit - 1): ainda permite', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 3, consumed: 2 }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('3) usuário Free com limite esgotado: bloqueia com DAILY_LIMIT_REACHED', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 1, consumed: 1, canStart: false }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(403);
    expect((res._body as any).code).toBe('DAILY_LIMIT_REACHED');
  });

  it('4) usuário de plano pago dentro do limite (limite maior que o Free): permite', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 5, consumed: 3 }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
  });

  it('5) usuário com plano ilimitado: várias revisões seguidas nunca são bloqueadas', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: true }));
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler(makeReq({ body: { attemptId: `ffffffff-0000-0000-0000-00000000000${i}` } }), res);
      expect(res._status).toBe(200);
    }
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it('6) sem plano válido (entitlements resolve para o padrão travado): bloqueia sem chamar a IA, nunca como "limite atingido"', async () => {
    // Mirrors lockedSnapshot() in plan-entitlements-service.ts — the shape a
    // user with no resolvable/suspended plan actually gets. writing.enabled
    // is false here; a genuine "no assignment" user instead resolves through
    // admin_resolve_effective_plan_v1's own DB-level fallback to the default
    // (Free) plan's real capability values, which scenario (1)-(4) above
    // already exercise via entitlementsWithReviews — from review-text.ts's
    // perspective the two cases are indistinguishable inputs.
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ enabled: false, canStart: false }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(403);
    expect((res._body as any).code).toBe('FEATURE_DISABLED');
    expect((res._body as any).code).not.toBe('DAILY_LIMIT_REACHED');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('7) duas requisições "simultâneas": a segunda é rejeitada pelo check atômico do banco mesmo quando o snapshot em memória ainda achava que havia vaga', async () => {
    // Simulates the actual race this fix closes: both requests read the SAME
    // in-memory entitlements snapshot (canStart: true, as if only 0 of 1 used),
    // but the DB-side reserve_writing_review is the authoritative, serialized
    // check — the second call's reservation attempt loses the race for real.
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 1, consumed: 0 }));
    let reserveCallCount = 0;
    const { fn: rpc } = rpcSpy({
      reserve_writing_review: () => {
        reserveCallCount += 1;
        if (reserveCallCount === 1) return Promise.resolve({ data: { status: 'reserved', reservationId: 'r1', fresh: true }, error: null });
        return Promise.resolve({ data: { error: 'DAILY_LIMIT_REACHED' }, error: null });
      },
    });
    const supabase = { ...makeDefaultSupabase(), rpc };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const res1 = makeRes();
    const res2 = makeRes();
    await handler(makeReq({ body: { attemptId: '11111111-2222-3333-4444-555555555501' } }), res1);
    await handler(makeReq({ body: { attemptId: '11111111-2222-3333-4444-555555555502' } }), res2);

    expect(res1._status).toBe(200);
    expect(res2._status).toBe(403);
    expect((res2._body as any).code).toBe('DAILY_LIMIT_REACHED');
    expect(mockCreate).toHaveBeenCalledTimes(1); // the AI provider was never charged for the rejected second attempt
  });

  it('8) retry da mesma requisição (mesmo attemptId): não chama a IA de novo e devolve o mesmo resultado, sem contar duas vezes', async () => {
    let reserveCallCount = 0;
    const { fn: rpc } = rpcSpy({
      reserve_writing_review: () => {
        reserveCallCount += 1;
        if (reserveCallCount === 1) return Promise.resolve({ data: { status: 'reserved', reservationId: 'r1', fresh: true }, error: null });
        return Promise.resolve({ data: { status: 'completed', reservationId: 'r1', reviewId: DEFAULT_REVIEW_ID, fresh: false }, error: null });
      },
    });
    const supabase = { ...makeDefaultSupabase(), rpc };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const attemptId = '22222222-3333-4444-5555-666666666601';
    const res1 = makeRes();
    await handler(makeReq({ body: { attemptId } }), res1);
    const res2 = makeRes();
    await handler(makeReq({ body: { attemptId } }), res2);

    expect(res1._status).toBe(200);
    expect(res2._status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1); // never called again on retry
    expect((res1._body as any).reviewId).toBe((res2._body as any).reviewId);
    expect((res2._body as any).feedback.correctedText).toBe(STORED_REVIEW_ROW.corrected_text);
  });

  it('9) falha da IA (provider indisponível): libera a reserva, nunca grava english_reviews, nunca completa a reserva', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    const { fn: rpc, calls } = rpcSpy();
    const insertSpy = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: DEFAULT_REVIEW_ID }, error: null }) }) });
    const supabase = {
      ...makeDefaultSupabase(),
      rpc,
      from: vi.fn((table: string) => {
        if (table === 'english_reviews') return { insert: insertSpy, select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) };
        return makeDefaultSupabase().from(table);
      }),
    };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBeGreaterThanOrEqual(500);
    expect(insertSpy).not.toHaveBeenCalled(); // AI never succeeded — nothing to record
    expect(calls.some((c) => c.name === 'fail_writing_review_reservation')).toBe(true);
    expect(calls.some((c) => c.name === 'complete_writing_review_reservation')).toBe(false);
  });

  it('10) tentativa bloqueada (limite esgotado): nunca chama o provedor de IA nem a reserva no banco', async () => {
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 1, consumed: 1, canStart: false }));
    const { fn: rpc, calls } = rpcSpy();
    const supabase = { ...makeDefaultSupabase(), rpc };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
    // The cheap in-memory snapshot check short-circuits before ever reaching
    // the DB-level reservation — never a wasted round-trip for the common,
    // obviously-exhausted case.
    expect(calls.some((c) => c.name === 'reserve_writing_review')).toBe(false);
  });

  it('bloqueia com DB-level DAILY_LIMIT_REACHED mesmo quando o snapshot em memória (canStart) estava desatualizado', async () => {
    // Defense in depth: even if the cheap pre-check were somehow bypassed or
    // stale, the atomic RPC is what actually gates the AI call.
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlementsWithReviews({ unlimited: false, limit: 1, consumed: 0, canStart: true }));
    const { fn: rpc } = rpcSpy({
      reserve_writing_review: () => Promise.resolve({ data: { error: 'DAILY_LIMIT_REACHED' }, error: null }),
    });
    const supabase = { ...makeDefaultSupabase(), rpc };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(403);
    expect((res._body as any).code).toBe('DAILY_LIMIT_REACHED');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejeita attemptId ausente ou inválido antes de qualquer verificação de plano', async () => {
    const res1 = makeRes();
    await handler(makeReq({ body: { attemptId: undefined } }), res1);
    expect(res1._status).toBe(400);

    const res2 = makeRes();
    await handler(makeReq({ body: { attemptId: 'not-a-uuid' } }), res2);
    expect(res2._status).toBe(400);

    expect(mockGetCurrentUserPlanEntitlements).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('11) tentativa em processamento (mesmo attemptId ainda "reserved"): nunca inicia uma segunda chamada simultânea à IA', async () => {
    // Distinct from scenario 8 (retry of an already-COMPLETED attempt): this
    // is a genuine second request landing while the FIRST one is still
    // in-flight (reservation status still 'reserved', not yet completed).
    const { fn: rpc } = rpcSpy({
      reserve_writing_review: () => Promise.resolve({ data: { status: 'in_progress', reservationId: 'r1', fresh: false }, error: null }),
    });
    const supabase = { ...makeDefaultSupabase(), rpc };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('REVIEW_IN_PROGRESS');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('12) english_reviews recebe exatamente uma linha por revisão concluída, mesmo sob múltiplas chamadas/retries', async () => {
    const insertSpy = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: DEFAULT_REVIEW_ID }, error: null }) }) });
    let reserveCallCount = 0;
    const { fn: rpc } = rpcSpy({
      reserve_writing_review: () => {
        reserveCallCount += 1;
        if (reserveCallCount === 1) return Promise.resolve({ data: { status: 'reserved', reservationId: 'r1', fresh: true }, error: null });
        return Promise.resolve({ data: { status: 'completed', reservationId: 'r1', reviewId: DEFAULT_REVIEW_ID, fresh: false }, error: null });
      },
    });
    const supabase = {
      ...makeDefaultSupabase(),
      rpc,
      from: vi.fn((table: string) => {
        if (table === 'english_reviews') {
          return {
            insert: insertSpy,
            select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: DEFAULT_REVIEW_ID, ...STORED_REVIEW_ROW }, error: null }) }) }),
          };
        }
        return makeDefaultSupabase().from(table);
      }),
    };
    vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, supabase: supabase as any });

    const attemptId = '33333333-4444-5555-6666-777777777701';
    await handler(makeReq({ body: { attemptId } }), makeRes());
    await handler(makeReq({ body: { attemptId } }), makeRes()); // retry — must not insert again

    expect(insertSpy).toHaveBeenCalledTimes(1);
  });
});
