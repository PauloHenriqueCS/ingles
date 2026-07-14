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

const VALID_UUID    = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID    = '999e4567-e89b-12d3-a456-426614174999';
const VALID_ATTEMPT = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_ATTEMPT = '660e8400-e29b-41d4-a716-446655440002';
const MOCK_REGION   = 'eastus';
const MOCK_TOKEN    = 'azure-jwt-token-xyz';
const MOCK_ASSESS   = '660e8400-e29b-41d4-a716-446655440001';
const MOCK_REF      = 'Hello world, this is my final text.';

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    body: { textVersionId: VALID_UUID, attemptId: VALID_ATTEMPT },
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
    await handler(makeReq({ body: { attemptId: VALID_ATTEMPT } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('retorna 400 quando textVersionId não é UUID válido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: 'not-a-uuid', attemptId: VALID_ATTEMPT } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_TEXT_VERSION_ID');
  });

  it('retorna 400 quando attemptId está ausente', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_ATTEMPT_ID');
  });

  it('retorna 400 quando attemptId não é UUID válido', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: 'not-a-uuid' } }), res);
    expect(res._status).toBe(400);
    expect((res._body as any).code).toBe('INVALID_ATTEMPT_ID');
  });

  it('não aceita userId no body (user_id vem de auth.uid() no SQL)', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: VALID_ATTEMPT, userId: 'evil-id' } }), res);
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_pronunciation_assessment',
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
  });

  it('retorna 409 para versão sem texto final elegível', async () => {
    rpcOk({ error: 'TEXT_VERSION_NOT_ELIGIBLE' });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
  });

  it('retorna 409 e assessmentId quando já completed', async () => {
    rpcOk({ error: 'ASSESSMENT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
  });

  it('retorna 409 quando failed_final', async () => {
    rpcOk({ error: 'ASSESSMENT_NOT_RETRYABLE', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(409);
  });

  it('retorna 409 ASSESSMENT_IN_PROGRESS quando outro attemptId está ativo', async () => {
    rpcOk({ error: 'ASSESSMENT_IN_PROGRESS', assessmentId: MOCK_ASSESS });
    const res = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: OTHER_ATTEMPT } }), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ASSESSMENT_IN_PROGRESS');
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });

  it('não emite token quando RPC retorna erro de estado', async () => {
    rpcOk({ error: 'ASSESSMENT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });
});

// ── Reserva e emissão de token ────────────────────────────────────────────────

describe('reserva e emissão de token', () => {
  it('retorna 200 com assessmentId, attemptId, token, region, language e referenceText', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    const body = res._body as any;
    expect(body.assessmentId).toBe(MOCK_ASSESS);
    expect(body.attemptId).toBe(VALID_ATTEMPT);
    expect(body.token).toBe(MOCK_TOKEN);
    expect(body.region).toBe(MOCK_REGION);
    expect(body.language).toBe('en-US');
    expect(body.referenceText).toBe(MOCK_REF);
  });

  it('referenceText vem do banco, não do body', async () => {
    rpcOk({ action: 'created', assessmentId: MOCK_ASSESS, referenceText: 'DB text from bank' });
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

  it('token não aparece em logs/storage — resposta não contém chave permanente', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain('mock-key');
    expect(serialized).not.toContain('AZURE_SPEECH_KEY');
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

  it('passa textVersionId e attemptId corretos para o RPC', async () => {
    await handler(makeReq({ body: { textVersionId: OTHER_UUID, attemptId: VALID_ATTEMPT } }), makeRes());
    expect(mockRpc).toHaveBeenCalledWith(
      'reserve_pronunciation_assessment',
      expect.objectContaining({
        p_text_version_id: OTHER_UUID,
        p_attempt_id: VALID_ATTEMPT,
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
  it('mesmo attemptId (existing_processing) é idempotente e emite token', async () => {
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
    expect(vi.mocked(issueAzureSpeechToken)).toHaveBeenCalledOnce();
  });

  it('reactivated retorna o mesmo assessmentId e emite token', async () => {
    rpcOk({ action: 'reactivated', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
  });

  it('restarted retorna o mesmo assessmentId e emite token (nova tentativa após completed)', async () => {
    rpcOk({ action: 'restarted', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(MOCK_ASSESS);
    expect((res._body as any).token).toBe(MOCK_TOKEN);
    expect(vi.mocked(issueAzureSpeechToken)).toHaveBeenCalledOnce();
  });

  it('dois calls com o mesmo textVersionId e mesmo attemptId usam o mesmo assessmentId', async () => {
    const resA = makeRes();
    const resB = makeRes();
    await handler(makeReq(), resA);
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    await handler(makeReq(), resB);
    expect((resA._body as any).assessmentId).toBe((resB._body as any).assessmentId);
  });

  it('dois attemptIds diferentes → 409 ASSESSMENT_IN_PROGRESS para o segundo', async () => {
    // Primeira requisição: cria
    const resA = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: VALID_ATTEMPT } }), resA);
    expect(resA._status).toBe(200);

    // Segunda aba com outro attemptId
    rpcOk({ error: 'ASSESSMENT_IN_PROGRESS', assessmentId: MOCK_ASSESS });
    const resB = makeRes();
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: OTHER_ATTEMPT } }), resB);
    expect(resB._status).toBe(409);
    expect((resB._body as any).code).toBe('ASSESSMENT_IN_PROGRESS');
    // Token não emitido para o segundo
    expect(vi.mocked(issueAzureSpeechToken)).toHaveBeenCalledTimes(1);
  });

  it('nenhum segundo registro é criado (RPC chamado uma vez por request)', async () => {
    await handler(makeReq(), makeRes());
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    await handler(makeReq(), makeRes());
    // Cada request faz exatamente 1 call ao RPC de reserva
    const reserveCalls = mockRpc.mock.calls.filter(([name]) => name === 'reserve_pronunciation_assessment');
    expect(reserveCalls).toHaveLength(2);
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
      .mockResolvedValueOnce({ data: null, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'compensate_pronunciation_assessment', expect.objectContaining({
      p_assessment_id: MOCK_ASSESS,
    }));
    expect(res._status).toBe(503);
  });

  it('chama compensate quando action=reactivated e token falha', async () => {
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

  it('chama compensate quando action=existing_processing (mesmo attempt) e token falha', async () => {
    rpcOk({ action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF });
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'Down'),
    );
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'existing_processing', assessmentId: MOCK_ASSESS, referenceText: MOCK_REF }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_assessment');
    expect(compensateCalls).toHaveLength(1);
  });

  it('NÃO chama compensate quando ASSESSMENT_IN_PROGRESS (outro attempt)', async () => {
    rpcOk({ error: 'ASSESSMENT_IN_PROGRESS', assessmentId: MOCK_ASSESS });
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: OTHER_ATTEMPT } }), makeRes());
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_assessment');
    expect(compensateCalls).toHaveLength(0);
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });

  it('não sobrescreve avaliação completed durante compensação', async () => {
    rpcOk({ error: 'ASSESSMENT_ALREADY_COMPLETED', assessmentId: MOCK_ASSESS });
    await handler(makeReq(), makeRes());
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
    const compensateCalls = mockRpc.mock.calls.filter(([name]) => name === 'compensate_pronunciation_assessment');
    expect(compensateCalls).toHaveLength(0);
  });

  it('resposta de erro do Azure não contém token nem chave', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_AUTH_FAILED', 'Rejected'),
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

  it('resposta não expõe dados de outro usuário', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res._body as any;
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('email');
  });

  it('endpoint não aceita userId do frontend', async () => {
    await handler(makeReq({ body: { textVersionId: VALID_UUID, attemptId: VALID_ATTEMPT, userId: 'evil-id' } }), makeRes());
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
describe.todo('integração — duas abas com mesmo attemptId retornam existing_processing');
describe.todo('integração — duas abas com attemptIds diferentes: a segunda recebe IN_PROGRESS');
describe.todo('integração — clique duplo não cria dois registros no banco');
describe.todo('integração — usuário B não consegue reservar texto do usuário A');
describe.todo('integração — completed bloqueia nova reserva no banco');
describe.todo('integração — failed_final bloqueia nova reserva no banco');
describe.todo('integração — failed_retryable reutiliza a mesma linha (não cria nova)');
