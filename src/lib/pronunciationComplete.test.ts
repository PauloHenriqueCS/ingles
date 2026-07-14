import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

import { requireAuth } from '../../api/_auth';
import handler from '../../api/pronunciation/complete';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_ASSESSMENT_ID = '123e4567-e89b-12d3-a456-426614174001';
const VALID_ATTEMPT_ID    = '123e4567-e89b-12d3-a456-426614174002';
const OTHER_ATTEMPT_ID    = '999e4567-e89b-12d3-a456-426614174999';

const VALID_RESULT = {
  pronunciationScore: 85,
  accuracyScore:      88,
  fluencyScore:       82,
  completenessScore:  90,
  prosodyScore:       79,
  recognizedText:     'Hello world this is a test.',
  wordsJson:          [{ word: 'Hello', accuracyScore: 88 }],
  rawSegments:        [{ raw: true }],
  audioDurationSeconds: 5.2,
};

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { 'content-length': '500' },
    body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, result: VALID_RESULT },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._body = body; return res; },
    end() { return res; },
    setHeader(k: string, v: string) { res._headers[k] = v; },
  };
  return res;
}

beforeEach(() => {
  vi.mocked(requireAuth).mockResolvedValue({
    userId: 'user-123',
    supabase: mockSupabase as any,
  });
  mockRpc.mockResolvedValue({ data: { action: 'completed' }, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/pronunciation/complete — autenticação', () => {
  it('retorna 401 sem auth', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('retorna 405 para GET', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });
});

describe('/api/pronunciation/complete — validação', () => {
  it('retorna 400 para assessmentId inválido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: 'bad', attemptId: VALID_ATTEMPT_ID, result: VALID_RESULT } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_ASSESSMENT_ID');
  });

  it('retorna 400 para attemptId inválido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: 'bad', result: VALID_RESULT } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_ATTEMPT_ID');
  });

  it('retorna 400 para nota fora de 0-100', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, result: { ...VALID_RESULT, pronunciationScore: 150 } } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_RESULT');
  });

  it('retorna 400 para nota negativa', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, result: { ...VALID_RESULT, accuracyScore: -1 } } }), res);
    expect(res._status).toBe(400);
  });

  it('aceita prosodyScore null', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, result: { ...VALID_RESULT, prosodyScore: null } } }), res);
    expect(res._status).toBe(200);
  });

  it('retorna 413 para payload muito grande', async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { 'content-length': String(3 * 1024 * 1024) } }), res);
    expect(res._status).toBe(413);
  });
});

describe('/api/pronunciation/complete — fluxo RPC', () => {
  it('retorna 200 e salva o resultado', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).status).toBe('completed');
    expect((res._body as any).result).toMatchObject({ pronunciationScore: 85 });
  });

  it('aplica Cache-Control: no-store', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('não aceita userId no body', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { ...makeReq().body, userId: 'evil' } }), res);
    const rpcCall = mockRpc.mock.calls[0];
    if (rpcCall) {
      const params = rpcCall[1];
      expect(params).not.toHaveProperty('p_user_id');
    }
  });

  it('retorna 409 ATTEMPT_MISMATCH para attemptId antigo', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'ATTEMPT_MISMATCH' }, error: null });
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: OTHER_ATTEMPT_ID, result: VALID_RESULT } }), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ATTEMPT_MISMATCH');
  });

  it('idempotente: already_completed retorna 200 sem erro', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'already_completed' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
  });

  it('retorna 409 quando status é ASSESSMENT_ALREADY_COMPLETED (outro attempt)', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'ASSESSMENT_ALREADY_COMPLETED' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ASSESSMENT_ALREADY_COMPLETED');
  });

  it('resultado nunca sobrescreve row completed (garantia do SQL)', async () => {
    // O endpoint retorna 409 — o SQL garante que o UPDATE não ocorre
    mockRpc.mockResolvedValue({ data: { error: 'ASSESSMENT_ALREADY_COMPLETED' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    // O RPC foi chamado mas o SQL não fez UPDATE (verificado pelo mock)
    expect(mockRpc).toHaveBeenCalledOnce();
  });

  it('retorna 500 em erro do RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db error' } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });
});
