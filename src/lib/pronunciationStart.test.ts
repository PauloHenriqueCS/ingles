import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted — these run before any imports below
vi.mock('../../api/_auth', () => ({
  requireAuth: vi.fn(),
}));

// Partial mock: keep AzureSpeechError real so instanceof checks in the handler work
vi.mock('../../api/_azure-speech', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/_azure-speech')>();
  return { ...mod, issueAzureSpeechToken: vi.fn() };
});

import { requireAuth } from '../../api/_auth';
import { issueAzureSpeechToken, AzureSpeechError } from '../../api/_azure-speech';
import handler from '../../api/pronunciation/start';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const VALID_UUID           = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID           = '999e4567-e89b-12d3-a456-426614174999';
const VALID_IDEM_KEY       = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_IDEM_KEY       = '660e8400-e29b-41d4-a716-446655440002';
const MOCK_REGION          = 'eastus';
const MOCK_TOKEN           = 'azure-jwt-token-xyz';
const MOCK_ASSESS          = '660e8400-e29b-41d4-a716-446655440001';
const MOCK_REF             = 'Hello world, this is my final text.';
const MOCK_OWNER           = '770e8400-e29b-41d4-a716-446655440003';

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: { textVersionId: VALID_UUID, idempotencyKey: VALID_IDEM_KEY },
    headers: { authorization: 'Bearer test-jwt' },
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

function rpcOk(data: unknown) {
  return mockRpc.mockResolvedValue({ data, error: null });
}

function rpcErr(message: string) {
  return mockRpc.mockResolvedValue({ data: null, error: { message } });
}


beforeEach(() => {
  vi.stubEnv('AZURE_SPEECH_REGION', MOCK_REGION);
  vi.stubEnv('AZURE_SPEECH_KEY', 'mock-key');

  vi.mocked(requireAuth).mockResolvedValue({
    userId: 'user-123',
    supabase: mockSupabase as any,
  });

  vi.mocked(issueAzureSpeechToken).mockResolvedValue({
    token: MOCK_TOKEN,
    region: MOCK_REGION,
    expiresInSeconds: 540,
  });

  // Default: reserve succeeds, confirm succeeds
  mockRpc
    .mockResolvedValueOnce({
      data: {
        action: 'created',
        assessmentId: MOCK_ASSESS,
        referenceText: MOCK_REF,
        reservationOwner: MOCK_OWNER,
        reservationVersion: 1,
      },
      error: null,
    })
    .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ── Autenticação ──────────────────────────────────────────────────────────────

describe('autenticação', () => {
  it('retorna 401 quando requireAuth falha', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });

  it('não emite token sem autenticação', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });
});

// ── Método HTTP ───────────────────────────────────────────────────────────────

describe('método HTTP', () => {
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

// ── Validação do payload ──────────────────────────────────────────────────────

describe('validação do payload', () => {
  it('retorna 400 quando textVersionId está ausente', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { idempotencyKey: VALID_IDEM_KEY } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('retorna 400 quando textVersionId não é UUID válido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: 'not-a-uuid', idempotencyKey: VALID_IDEM_KEY } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('retorna 400 quando idempotencyKey está ausente', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('retorna 400 quando idempotencyKey não é UUID válido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, idempotencyKey: 'not-a-uuid' } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('não aceita userId no body (user_id vem de auth.uid() no SQL)', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, idempotencyKey: VALID_IDEM_KEY, userId: 'evil-id' } }), res);
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_pronunciation_attempt',
      expect.objectContaining({ p_text_version_id: VALID_UUID }),
    );
    const rpcCall = mockRpc.mock.calls[0];
    expect(rpcCall[1]).not.toHaveProperty('p_user_id');
  });
});

// ── Azure não configurado ─────────────────────────────────────────────────────

describe('Azure não configurado', () => {
  it('retorna 503 quando AZURE_SPEECH_REGION está ausente', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', '');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(503);
    expect((res._body as any).code).toBe('AZURE_SPEECH_NOT_CONFIGURED');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── Erros do RPC de reserva ───────────────────────────────────────────────────

describe('erros do RPC de reserva', () => {
  it('retorna 500 quando o RPC retorna error', async () => {
    mockRpc.mockReset();
    rpcErr('db error');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
    expect((res._body as any).code).toBe('INTERNAL_ERROR');
  });

  it('retorna 404 para versão inexistente ou de outro usuário', async () => {
    mockRpc.mockReset();
    rpcOk({ error: 'TEXT_VERSION_NOT_FOUND' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(404);
  });

  it('retorna 409 para versão sem texto final elegível', async () => {
    mockRpc.mockReset();
    rpcOk({ error: 'TEXT_VERSION_NOT_ELIGIBLE' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
  });

  it('retorna 409 e assessmentId quando tentativa já completed', async () => {
    mockRpc.mockReset();
    rpcOk({ error: 'ATTEMPT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
  });

  it('retorna 409 quando tentativa já failed', async () => {
    mockRpc.mockReset();
    rpcOk({ error: 'ATTEMPT_ALREADY_FAILED', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
  });

  it('não emite token quando RPC retorna erro de estado', async () => {
    mockRpc.mockReset();
    rpcOk({ error: 'ATTEMPT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });
});

// ── Reserva e emissão de token ────────────────────────────────────────────────

describe('reserva e emissão de token', () => {
  it('retorna 200 com assessmentId, token, region, language e referenceText', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    const body = res._body as any;
    expect(body.assessmentId).toBe(MOCK_ASSESS);
    expect(body.token).toBe(MOCK_TOKEN);
    expect(body.region).toBe(MOCK_REGION);
    expect(body.language).toBe('en-US');
    expect(body.referenceText).toBe(MOCK_REF);
  });

  it('resposta não contém idempotencyKey', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body as any)).not.toHaveProperty('idempotencyKey');
    expect((res._body as any)).not.toHaveProperty('attemptId');
  });

  it('referenceText vem do banco, não do body', async () => {
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({
        data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: 'DB text from bank', reservationOwner: MOCK_OWNER, reservationVersion: 1 },
        error: null,
      })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body as any).referenceText).toBe('DB text from bank');
  });

  it('aplica Cache-Control: no-store', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('não retorna a chave permanente AZURE_SPEECH_KEY', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(JSON.stringify(res._body)).not.toContain('mock-key');
    expect(JSON.stringify(res._body)).not.toContain('AZURE_SPEECH_KEY');
  });

  it('emite o token somente depois da reserva ser confirmada', async () => {
    const callOrder: string[] = [];
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (name: string) => {
      callOrder.push(name);
      if (name === 'reserve_pronunciation_attempt') {
        return { data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF, reservationOwner: MOCK_OWNER, reservationVersion: 1 }, error: null };
      }
      return { data: { action: 'confirmed' }, error: null };
    });
    vi.mocked(issueAzureSpeechToken).mockImplementation(async () => {
      callOrder.push('token');
      return { token: MOCK_TOKEN, region: MOCK_REGION, expiresInSeconds: 540 };
    });
    await handler(makeReq(), makeRes());
    expect(callOrder[0]).toBe('reserve_pronunciation_attempt');
    expect(callOrder[1]).toBe('token');
    expect(callOrder[2]).toBe('confirm_pronunciation_preparation');
  });

  it('passa textVersionId e idempotencyKey corretos para o RPC', async () => {
    await handler(makeReq({ body: { textVersionId: OTHER_UUID, idempotencyKey: VALID_IDEM_KEY } }), makeRes());
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_pronunciation_attempt',
      expect.objectContaining({
        p_text_version_id: OTHER_UUID,
        p_idempotency_key: VALID_IDEM_KEY,
      }),
    );
  });

  it('usa o idioma en-US fixo', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body as any).language).toBe('en-US');
  });

  it('região vem da configuração do servidor, não do body', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', 'brazilsouth');
    vi.mocked(issueAzureSpeechToken).mockResolvedValue({ token: MOCK_TOKEN, region: 'brazilsouth', expiresInSeconds: 540 });
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body as any).region).toBe('brazilsouth');
  });
});

// ── Idempotência e concorrência ───────────────────────────────────────────────

describe('idempotência e concorrência', () => {
  it('mesma idempotencyKey (existing_processing) é idempotente e emite token', async () => {
    mockRpc.mockReset();
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
    expect(vi.mocked(issueAzureSpeechToken)).toHaveBeenCalledOnce();
  });

  it('existing_processing não chama confirm (row já está processing)', async () => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null });
    await handler(makeReq(), makeRes());
    const confirmCalls = mockRpc.mock.calls.filter(([name]) => name === 'confirm_pronunciation_preparation');
    expect(confirmCalls).toHaveLength(0);
  });

  it('existing_preparing retorna 409 ASSESSMENT_PREPARING sem emitir token', async () => {
    mockRpc.mockReset();
    rpcOk({ action: 'existing_preparing', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ASSESSMENT_PREPARING');
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });

  it('duas chamadas com a mesma idempotencyKey usam o mesmo assessmentId', async () => {
    // First call: created
    const resA = makeRes();
    await handler(makeReq(), resA);

    // Second call: existing_processing (same key, token already issued)
    mockRpc.mockReset();
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const resB = makeRes();
    await handler(makeReq(), resB);

    expect((resA._body as any).assessmentId).toBe((resB._body as any).assessmentId);
  });

  it('idempotencyKeys diferentes criam avaliações independentes', async () => {
    const resA = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, idempotencyKey: VALID_IDEM_KEY } }), resA);
    expect(resA._status).toBe(200);

    mockRpc.mockReset();
    const OTHER_ASSESS = '880e8400-e29b-41d4-a716-446655440008';
    mockRpc
      .mockResolvedValueOnce({
        data: { action: 'created', assessmentId: OTHER_ASSESS, referenceText: MOCK_REF, reservationOwner: MOCK_OWNER, reservationVersion: 1 },
        error: null,
      })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });

    const resB = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, idempotencyKey: OTHER_IDEM_KEY } }), resB);
    expect(resB._status).toBe(200);

    expect((resA._body as any).assessmentId).not.toBe((resB._body as any).assessmentId);
  });

  it('nenhum segundo registro é criado (RPC chamado uma vez por request)', async () => {
    await handler(makeReq(), makeRes());
    mockRpc.mockReset();
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    await handler(makeReq(), makeRes());
    const reserveCalls = mockRpc.mock.calls.filter(([name]) => name === 'reserve_pronunciation_attempt');
    expect(reserveCalls).toHaveLength(1);
  });
});

// ── Compensação após falha do token ──────────────────────────────────────────

describe('compensação após falha do Azure', () => {
  it('chama compensate_pronunciation_attempt com reservation_owner quando created e token falha', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Service down'),
    );
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({
        data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF, reservationOwner: MOCK_OWNER, reservationVersion: 1 },
        error: null,
      })
      .mockResolvedValue({ data: null, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_attempt');
    expect(compensateCalls).toHaveLength(1);
    expect(compensateCalls[0][1]).toMatchObject({
      p_assessment_id:       MOCK_ASSESS,
      p_reservation_owner:   MOCK_OWNER,
      p_reservation_version: 1,
    });
    expect(res._status).toBe(503);
  });

  it('NÃO chama compensate quando existing_processing e token falha (assessment permanece processing)', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Service down'),
    );
    mockRpc.mockReset();
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_attempt');
    expect(compensateCalls).toHaveLength(0);
    expect(res._status).toBe(503);
  });

  it('compensação exige reservation_owner correto — resposta inclui p_reservation_owner', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'Timed out'),
    );
    const CUSTOM_OWNER = 'aabbccdd-0000-0000-0000-000000000001';
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({
        data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF, reservationOwner: CUSTOM_OWNER, reservationVersion: 1 },
        error: null,
      })
      .mockResolvedValue({ data: null, error: null });
    await handler(makeReq(), makeRes());
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_attempt');
    expect(compensateCalls[0][1].p_reservation_owner).toBe(CUSTOM_OWNER);
  });

  it('não sobrescreve avaliação completed durante compensação (RPC simplesmente retorna no_op)', async () => {
    mockRpc.mockReset();
    rpcOk({ error: 'ATTEMPT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_attempt');
    expect(compensateCalls).toHaveLength(0);
  });

  it('resposta de erro do Azure não contém token nem chave', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', 'Rejected'),
    );
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({
        data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF, reservationOwner: MOCK_OWNER, reservationVersion: 1 },
        error: null,
      })
      .mockResolvedValue({ data: null, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain(MOCK_TOKEN);
    expect(serialized).not.toContain('mock-key');
  });

  it('reservation_owner nunca aparece na resposta ao browser', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain(MOCK_OWNER);
    expect(serialized).not.toContain('reservationOwner');
    expect(serialized).not.toContain('reservation_owner');
  });
});

// ── Segurança da resposta ─────────────────────────────────────────────────────

describe('segurança da resposta', () => {
  it('resposta bem-sucedida não contém a chave permanente', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(JSON.stringify(res._body)).not.toContain('mock-key');
  });

  it('resposta não expõe dados de outro usuário', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as any;
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('email');
  });

  it('endpoint não aceita userId do frontend', async () => {
    await handler(makeReq({ body: { textVersionId: VALID_UUID, idempotencyKey: VALID_IDEM_KEY, userId: 'evil-id' } }), makeRes());
    const rpcCall = mockRpc.mock.calls[0];
    if (rpcCall) {
      const [, params] = rpcCall;
      expect(params).not.toHaveProperty('p_user_id');
      expect(params).not.toHaveProperty('userId');
    }
  });

  it('Cache-Control: no-store na resposta de sucesso', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });
});

// ── Testes de integração que requerem DB real ─────────────────────────────────

describe.todo('integração — constraint UNIQUE(user_id,idempotency_key) impede duplicata em chamadas concorrentes');
describe.todo('integração — duas abas com mesma idempotencyKey: segunda recebe ASSESSMENT_PREPARING ou existing_processing');
describe.todo('integração — duas análises intencionais do mesmo texto geram duas linhas');
describe.todo('integração — clique duplo não cria dois registros no banco');
describe.todo('integração — usuário B não consegue reservar texto do usuário A');
describe.todo('integração — compensate_pronunciation_attempt é no_op com reservation_owner incorreto');
