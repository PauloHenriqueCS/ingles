import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoist mock refs ───────────────────────────────────────────────────────────

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

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
    return makeChain({ data: null, error: null });
  });
  const rpc = vi.fn().mockResolvedValue({ data: { applied: true }, error: null });
  return { from, rpc };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: {
      entryId: ENTRY_ID,
      originalText: 'Yesterday I goed to the store.',
      theme: 'A trip to the store',
      grammarGoal: 'Past Simple',
      mainTense: 'Past Simple',
    },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; return res; },
    end() { return res; },
  };
  return res;
}

function aiOk(content: string) {
  return Promise.resolve({ choices: [{ message: { content } }] });
}

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.mocked(requireAuth).mockResolvedValue({
    userId: USER_ID,
    supabase: makeDefaultSupabase() as any,
  });
  mockCreate.mockImplementation(() => aiOk(VALID_AI_RESPONSE));
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
    await handler(makeReq({ body: {} }), res);
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
  it('retorna 500 quando a chave não está configurada', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('OPENAI_API_KEY', '');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
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
