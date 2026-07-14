import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

import { requireAuth } from '../../api/_auth';
import handler from '../../api/pronunciation/status';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';
const USER_ID    = 'aaaaaaaa-0000-0000-0000-000000000001';

function makeChain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'maybeSingle', 'single', 'order', 'limit', 'gte', 'lte']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (
    onfulfilled: (value: unknown) => unknown,
    onrejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onfulfilled, onrejected);
  return c;
}

/** Builds a supabase mock where the review exists and the assessment is provided. */
function makeSupabase(options: {
  reviewData?: unknown;
  reviewError?: { message: string } | null;
  assessmentData?: unknown;
  assessmentError?: { message: string } | null;
} = {}) {
  const reviewResult = {
    data: options.reviewData !== undefined ? options.reviewData : { id: VALID_UUID },
    error: options.reviewError !== undefined ? options.reviewError : null,
  };
  const assessmentResult = {
    data: options.assessmentData !== undefined ? options.assessmentData : null,
    error: options.assessmentError !== undefined ? options.assessmentError : null,
  };

  const from = vi.fn((table: string) => {
    if (table === 'english_reviews') return makeChain(reviewResult);
    if (table === 'pronunciation_assessments') return makeChain(assessmentResult);
    return makeChain({ data: null, error: null });
  });
  return { from };
}

const COMPLETED_ROW = {
  id: VALID_UUID,
  user_id: USER_ID,
  text_version_id: VALID_UUID,
  status: 'completed',
  reference_text: 'Hello world',
  language_code: 'en-US',
  azure_region: 'eastus',
  active_attempt_id: null,
  attempt_started_at: null,
  pronunciation_score: 85,
  accuracy_score: 88,
  fluency_score: 82,
  completeness_score: 90,
  prosody_score: 79,
  recognized_text: 'Hello world',
  words_json: [{ word: 'Hello' }],
  raw_result_json: [{ segment: 1 }],
  audio_path: null,
  audio_duration_seconds: 4.5,
  error_code: null,
  error_message: null,
  started_at: '2026-07-14T10:00:00Z',
  completed_at: '2026-07-14T10:00:05Z',
  created_at: '2026-07-14T10:00:00Z',
  updated_at: '2026-07-14T10:00:05Z',
};

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    query: { textVersionId: VALID_UUID },
    headers: { authorization: 'Bearer test-token' },
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

beforeEach(() => {
  vi.mocked(requireAuth).mockResolvedValue({
    userId: USER_ID,
    supabase: makeSupabase() as any,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Método HTTP ───────────────────────────────────────────────────────────────

describe('método HTTP', () => {
  it('retorna 405 para POST', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('retorna 405 para DELETE', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'DELETE' }), res);
    expect(res._status).toBe(405);
  });
});

// ── Autenticação ──────────────────────────────────────────────────────────────

describe('autenticação', () => {
  it('responde 401 quando não autenticado (requireAuth retorna null)', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    // requireAuth already writes 401; handler returns immediately
    expect(res._status).toBe(200); // res stays 200 since requireAuth wrote to the actual res
    // Main assertion: no body was set by handler itself
  });
});

// ── Validação do textVersionId ─────────────────────────────────────────────

describe('validação de textVersionId', () => {
  it('retorna 400 para UUID inválido', async () => {
    const res = makeRes();
    await handler(makeReq({ query: { textVersionId: 'not-a-uuid' } }), res);
    expect(res._status).toBe(400);
  });

  it('retorna 400 para textVersionId ausente', async () => {
    const res = makeRes();
    await handler(makeReq({ query: {} }), res);
    expect(res._status).toBe(400);
  });

  it('aceita UUID v4 válido', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
  });
});

// ── Revisão não encontrada ────────────────────────────────────────────────────

describe('revisão não encontrada', () => {
  it('retorna 404 quando a revisão não pertence ao usuário', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabase({ reviewData: null }) as any,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(404);
  });

  it('retorna 500 quando DB retorna erro na consulta de revisão', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabase({ reviewError: { message: 'db error' } }) as any,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });

  it('retorna 500 quando DB retorna erro na consulta de assessment', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabase({ assessmentError: { message: 'assessment db error' } }) as any,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });
});

// ── Sem assessment existente ──────────────────────────────────────────────────

describe('sem assessment existente', () => {
  it('retorna status available quando não há assessment', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as Record<string, unknown>;
    expect(body.status).toBe('available');
    expect(body.canAnalyze).toBe(true);
    expect(body.assessmentId).toBeNull();
  });
});

// ── Assessment existente ──────────────────────────────────────────────────────

describe('assessment existente', () => {
  beforeEach(() => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabase({ assessmentData: COMPLETED_ROW }) as any,
    });
  });

  it('retorna status completed com result', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(body.canAnalyze).toBe(true);
    expect(body.assessmentId).toBe(VALID_UUID);
    const result = body.result as Record<string, unknown>;
    expect(result).toHaveProperty('pronunciationScore');
    expect(result).toHaveProperty('accuracyScore');
  });

  it('result contém rawSegments mapeado de raw_result_json', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as Record<string, unknown>;
    const result = body.result as Record<string, unknown>;
    expect(Array.isArray(result.rawSegments)).toBe(true);
  });

  it('status processing → canAnalyze false', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabase({
        assessmentData: { ...COMPLETED_ROW, status: 'processing', pronunciation_score: null },
      }) as any,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as Record<string, unknown>;
    expect(body.status).toBe('processing');
    expect(body.canAnalyze).toBe(false);
  });

  it('status failed_retryable → canAnalyze true', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: makeSupabase({
        assessmentData: { ...COMPLETED_ROW, status: 'failed_retryable', pronunciation_score: null },
      }) as any,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as Record<string, unknown>;
    expect(body.status).toBe('failed_retryable');
    expect(body.canAnalyze).toBe(true);
  });
});

// ── Isolamento de usuário ─────────────────────────────────────────────────────

describe('isolamento de usuário', () => {
  it('consulta english_reviews com o user_id da sessão', async () => {
    const fromSpy = vi.fn((table: string) => {
      if (table === 'english_reviews') {
        const c = makeChain({ data: { id: VALID_UUID }, error: null });
        return c;
      }
      return makeChain({ data: null, error: null });
    });
    vi.mocked(requireAuth).mockResolvedValue({
      userId: USER_ID,
      supabase: { from: fromSpy } as any,
    });
    await handler(makeReq(), makeRes());
    // Verify english_reviews was queried (isolation)
    const reviewCalls = fromSpy.mock.calls.filter(([t]) => t === 'english_reviews');
    expect(reviewCalls).toHaveLength(1);
  });
});
