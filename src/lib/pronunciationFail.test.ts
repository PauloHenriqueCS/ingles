import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

import { requireAuth } from '../../api/_auth';
import handler from '../../api/pronunciation/fail';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_ASSESSMENT_ID = '123e4567-e89b-12d3-a456-426614174001';
const VALID_ATTEMPT_ID    = '123e4567-e89b-12d3-a456-426614174002';
const OLD_ATTEMPT_ID      = '888e4567-e89b-12d3-a456-426614174888';

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: {},
    body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, code: 'AZURE_CANCELED' },
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
    setHeader() { return res; },
  };
  return res;
}

beforeEach(() => {
  vi.mocked(requireAuth).mockResolvedValue({
    userId: 'user-123',
    supabase: mockSupabase as any,
  });
  mockRpc.mockResolvedValue({ data: { action: 'failed_retryable' }, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/pronunciation/fail — autenticação e validação', () => {
  it('retorna 401 sem auth', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('retorna 405 para GET', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('retorna 400 para assessmentId inválido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: 'bad', attemptId: VALID_ATTEMPT_ID, code: 'AZURE_CANCELED' } }), res);
    expect(res._status).toBe(400);
  });

  it('retorna 400 para attemptId inválido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: 'bad', code: 'AZURE_CANCELED' } }), res);
    expect(res._status).toBe(400);
  });

  it('rejeita código não permitido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, code: 'ARBITRARY_ERROR' } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_ERROR_CODE');
  });

  it('aceita todos os códigos da allowlist', async () => {
    const allowed = ['AUDIO_DECODE_FAILED', 'AUDIO_EMPTY', 'AZURE_NO_MATCH', 'AZURE_CANCELED',
                     'AZURE_TIMEOUT', 'AZURE_NETWORK_ERROR', 'RESULT_INVALID', 'CLIENT_INTERRUPTED'];
    for (const code of allowed) {
      const res = makeRes();
      await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, code } }), res);
      expect(res._status).toBe(200);
    }
  });
});

describe('/api/pronunciation/fail — comportamento', () => {
  it('marca avaliação como failed_retryable', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).status).toBe('failed_retryable');
  });

  it('não altera row completed (SQL retorna no_op)', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'no_op', reason: 'completed' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).status).toBe('no_op');
  });

  it('attemptId antigo produz no_op (não afeta tentativa nova)', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'no_op', reason: 'not_owner' }, error: null });
    const res = makeRes();
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: OLD_ATTEMPT_ID, code: 'CLIENT_INTERRUPTED' } }), res);
    expect(res._status).toBe(200);
    expect((res._body as any).status).toBe('no_op');
    expect(mockRpc).toHaveBeenCalledWith('fail_pronunciation_assessment', expect.objectContaining({
      p_attempt_id: OLD_ATTEMPT_ID,
    }));
  });

  it('failed_final produz no_op', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'no_op', reason: 'failed_final' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
  });

  it('passa p_error_code correto ao RPC', async () => {
    await handler(makeReq({ body: { assessmentId: VALID_ASSESSMENT_ID, attemptId: VALID_ATTEMPT_ID, code: 'AUDIO_DECODE_FAILED' } }), makeRes());
    expect(mockRpc).toHaveBeenCalledWith('fail_pronunciation_assessment', expect.objectContaining({
      p_error_code: 'AUDIO_DECODE_FAILED',
    }));
  });

  it('nunca aceita mensagem de erro livre do cliente', async () => {
    const res = makeRes();
    await handler(makeReq({ body: {
      assessmentId: VALID_ASSESSMENT_ID,
      attemptId: VALID_ATTEMPT_ID,
      code: 'AZURE_CANCELED',
      message: 'arbitrary client message',
    } }), res);
    const rpcCall = mockRpc.mock.calls[0];
    if (rpcCall) {
      const params = rpcCall[1];
      expect(params).not.toHaveProperty('p_error_message');
      expect(params).not.toHaveProperty('message');
    }
  });

  it('retorna 500 em erro do RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db error' } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
  });
});
