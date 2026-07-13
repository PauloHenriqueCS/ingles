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

const VALID_UUID   = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID   = '999e4567-e89b-12d3-a456-426614174999';
const MOCK_REGION  = 'eastus';
const MOCK_TOKEN   = 'azure-jwt-token-xyz';
const MOCK_ASSESS  = '660e8400-e29b-41d4-a716-446655440001';
const MOCK_REF     = 'Hello world, this is my final text.';

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: { textVersionId: VALID_UUID },
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

function reserveCreated() {
  rpcOk({ action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
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

  reserveCreated();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ── Authentication ────────────────────────────────────────────────────────────

describe('autenticação', () => {
  it('retorna 401 quando requireAuth falha', async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    // requireAuth já respondeu — o handler apenas retorna
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
    await handler(makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('retorna 400 quando textVersionId não é string', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: 12345 } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('retorna 400 para UUID com formato inválido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: 'not-a-uuid' } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('não aceita userId no body', async () => {
    // Extra fields are ignored; textVersionId must be valid UUID
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, userId: 'evil-id' } }), res);
    // Should proceed to RPC (userId from body is silently ignored)
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_pronunciation_assessment',
      expect.objectContaining({ p_text_version_id: VALID_UUID }),
    );
    // The user_id used in the RPC comes from auth.uid() inside the SQL function
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

// ── Reserva — erros do banco ──────────────────────────────────────────────────

describe('erros do RPC de reserva', () => {
  it('retorna 500 quando o RPC retorna error', async () => {
    rpcErr('db error');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(500);
    expect((res._body as any).code).toBe('INTERNAL_ERROR');
  });

  it('retorna 404 para versão inexistente ou de outro usuário', async () => {
    rpcOk({ error: 'TEXT_VERSION_NOT_FOUND' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(404);
    expect((res._body as any).code).toBe('TEXT_VERSION_NOT_FOUND');
  });

  it('retorna 409 para versão sem texto final elegível', async () => {
    rpcOk({ error: 'TEXT_VERSION_NOT_ELIGIBLE' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('TEXT_VERSION_NOT_ELIGIBLE');
  });

  it('retorna 409 e assessmentId quando já completed', async () => {
    rpcOk({ error: 'ASSESSMENT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ASSESSMENT_ALREADY_COMPLETED');
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
  });

  it('retorna 409 quando failed_final', async () => {
    rpcOk({ error: 'ASSESSMENT_NOT_RETRYABLE', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ASSESSMENT_NOT_RETRYABLE');
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
  });

  it('não emite token quando RPC retorna erro de estado', async () => {
    rpcOk({ error: 'ASSESSMENT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });
});

// ── Reserva bem-sucedida ──────────────────────────────────────────────────────

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

  it('snapshot do texto é o que veio do banco (não do body)', async () => {
    rpcOk({ action: 'created', assessmentId: MOCK_ASSESS, referenceText: 'DB text from bank' });
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID } }), res);
    expect((res._body as any).referenceText).toBe('DB text from bank');
  });

  it('aplica Cache-Control: no-store na resposta com token', async () => {
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
    mockRpc.mockImplementation(async () => {
      callOrder.push('rpc');
      return { data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null };
    });
    vi.mocked(issueAzureSpeechToken).mockImplementation(async () => {
      callOrder.push('token');
      return { token: MOCK_TOKEN, region: MOCK_REGION, expiresInSeconds: 540 };
    });

    await handler(makeReq(), makeRes());

    expect(callOrder).toEqual(['rpc', 'token']);
  });

  it('passa o textVersionId correto para o RPC', async () => {
    await handler(makeReq({ body: { textVersionId: OTHER_UUID } }), makeRes());
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_pronunciation_assessment',
      expect.objectContaining({ p_text_version_id: OTHER_UUID }),
    );
  });

  it('usa o idioma en-US fixo', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body as any).language).toBe('en-US');
  });

  it('a região na resposta vem da configuração do servidor, não do body', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', 'brazilsouth');
    vi.mocked(issueAzureSpeechToken).mockResolvedValue({
      token: MOCK_TOKEN,
      region: 'brazilsouth',
      expiresInSeconds: 540,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body as any).region).toBe('brazilsouth');
  });
});

// ── Idempotência e estados concorrentes ───────────────────────────────────────

describe('idempotência e concorrência', () => {
  it('existing_processing retorna o mesmo assessmentId sem criar nova avaliação', async () => {
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
    // RPC chamado exatamente uma vez — não criou duplicata
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('reactivated retorna o mesmo assessmentId', async () => {
    rpcOk({ action: 'reactivated', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
  });

  it('dois calls com o mesmo textVersionId usam o mesmo assessmentId', async () => {
    const resA = makeRes();
    const resB = makeRes();
    await handler(makeReq(), resA);
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    await handler(makeReq(), resB);
    expect((resA._body as any).assessmentId).toBe((resB._body as any).assessmentId);
  });
});

// ── Compensação após falha do token ──────────────────────────────────────────

describe('compensação após falha do Azure', () => {
  it('chama compensate quando action=created e token falha', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Service down'),
    );
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null })
      .mockResolvedValueOnce({ data: null, error: null }); // compensate call

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockRpc).toHaveBeenNthCalledWith(2, 'compensate_pronunciation_assessment', {
      p_assessment_id: MOCK_ASSESS,
      p_error_code: 'AZURE_SPEECH_UNAVAILABLE',
      p_error_message: expect.any(String),
    });
    expect(res._status).toBe(503);
  });

  it('chama compensate quando action=reactivated e token falha', async () => {
    rpcOk({ action: 'reactivated', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'Timed out'),
    );
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'reactivated', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(mockRpc).toHaveBeenCalledWith('compensate_pronunciation_assessment', expect.objectContaining({
      p_assessment_id: MOCK_ASSESS,
    }));
    expect(res._status).toBe(504);
  });

  it('NÃO chama compensate quando action=existing_processing e token falha', async () => {
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Down'),
    );
    mockRpc.mockResolvedValue({ data: { action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null });

    await handler(makeReq(), makeRes());

    // compensate_pronunciation_assessment deve NÃO ter sido chamado
    const compensateCalls = mockRpc.mock.calls.filter(
      ([name]) => name === 'compensate_pronunciation_assessment',
    );
    expect(compensateCalls).toHaveLength(0);
  });

  it('não sobrescreve avaliação completed durante compensação', async () => {
    // O SQL function da compensação só atualiza WHERE status = 'processing'
    // Este teste verifica que a compensação não é chamada fora de contexto
    rpcOk({ error: 'ASSESSMENT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });

    await handler(makeReq(), makeRes());

    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
    const compensateCalls = mockRpc.mock.calls.filter(
      ([name]) => name === 'compensate_pronunciation_assessment',
    );
    expect(compensateCalls).toHaveLength(0);
  });

  it('resposta de erro do Azure não contém token nem chave', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', 'Credentials rejected'),
    );
    mockRpc.mockResolvedValue({ data: { action: 'created', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null });

    const res = makeRes();
    await handler(makeReq(), res);

    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain(MOCK_TOKEN);
    expect(serialized).not.toContain('mock-key');
  });
});

// ── Segurança da resposta ─────────────────────────────────────────────────────

describe('segurança da resposta', () => {
  it('resposta bem-sucedida não contém a chave permanente', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(JSON.stringify(res._body)).not.toContain('mock-key');
  });

  it('resposta bem-sucedida não expõe dados de outro usuário', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as any;
    // O referenceText vem do banco (mockado), não do body da request
    expect(body.referenceText).toBe(MOCK_REF);
    // Não há campo userId, email ou dados do usuário na resposta
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('email');
  });

  it('endpoint não aceita userId do frontend', async () => {
    await handler(makeReq({ body: { textVersionId: VALID_UUID, userId: 'evil-id' } }), makeRes());
    // O p_user_id não é enviado ao RPC — o user_id real vem de auth.uid() dentro do SQL
    const rpcCall = mockRpc.mock.calls[0];
    if (rpcCall) {
      const [, params] = rpcCall;
      expect(params).not.toHaveProperty('p_user_id');
      expect(params).not.toHaveProperty('userId');
    }
  });
});

// ── Testes de integração que requerem DB real ─────────────────────────────────

describe.todo('integração — constraint UNIQUE impede duplicata em chamadas concorrentes reais');
describe.todo('integração — duas abas simultâneas retornam o mesmo assessmentId');
describe.todo('integração — clique duplo não cria dois registros no banco');
describe.todo('integração — usuário B não consegue reservar texto do usuário A');
describe.todo('integração — completed bloqueia nova reserva no banco');
describe.todo('integração — failed_final bloqueia nova reserva no banco');
describe.todo('integração — failed_retryable reutiliza a mesma linha (não cria nova)');
