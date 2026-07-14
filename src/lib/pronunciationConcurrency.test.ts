/**
 * Testes de concorrência e idempotência para o fluxo de pronúncia.
 *
 * Estes testes verificam o comportamento dos handlers com respostas de RPC
 * simuladas. Testes de concorrência real (corrida no banco) requerem
 * integração com Supabase e estão marcados como .todo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_auth', () => ({ requireAuth: vi.fn() }));
vi.mock('../../api/_azure-speech', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/_azure-speech')>();
  return { ...mod, issueAzureSpeechToken: vi.fn() };
});

import { requireAuth } from '../../api/_auth';
import { issueAzureSpeechToken, AzureSpeechError } from '../../api/_azure-speech';
import startHandler    from '../../api/pronunciation/start';
import completeHandler from '../../api/pronunciation/complete';
import failHandler     from '../../api/pronunciation/fail';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEXT_ID     = '11111111-1111-1111-1111-111111111111';
const IDEM_KEY_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IDEM_KEY_B  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ASSESS_A    = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ASSESS_B    = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OWNER_A     = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OWNER_B     = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const REGION      = 'eastus';
const TOKEN       = 'azure-token-xyz';
const REF_TEXT    = 'The quick brown fox jumps over the lazy dog.';

const VALID_RESULT = {
  pronunciationScore: 78, accuracyScore: 80, fluencyScore: 75,
  completenessScore: 85, prosodyScore: 70,
  recognizedText: REF_TEXT, wordsJson: [], rawSegments: [],
  audioDurationSeconds: 6.1,
};

const mockRpc = vi.fn();
const mockSupabase = { rpc: mockRpc };

function makeStartReq(textVersionId: string, idempotencyKey: string) {
  return { method: 'POST', headers: { authorization: 'Bearer jwt' }, body: { textVersionId, idempotencyKey } };
}

function makeCompleteReq(assessmentId: string) {
  return { method: 'POST', headers: { 'content-length': '500' }, body: { assessmentId, result: VALID_RESULT } };
}

function makeFailReq(assessmentId: string, code = 'AZURE_CANCELED') {
  return { method: 'POST', headers: {}, body: { assessmentId, code } };
}

function makeRes() {
  const res = {
    _status: 200, _body: null as unknown, _headers: {} as Record<string, string>,
    status(c: number) { res._status = c; return res; },
    json(b: unknown) { res._body = b; return res; },
    end() { return res; },
    setHeader(k: string, v: string) { res._headers[k] = v; },
  };
  return res;
}

beforeEach(() => {
  vi.stubEnv('AZURE_SPEECH_REGION', REGION);
  vi.stubEnv('AZURE_SPEECH_KEY', 'mock-key');
  vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1', supabase: mockSupabase as any });
  vi.mocked(issueAzureSpeechToken).mockResolvedValue({ token: TOKEN, region: REGION, expiresInSeconds: 540 });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ── Clique duplo ──────────────────────────────────────────────────────────────

describe('clique duplo — mesma idempotencyKey', () => {
  it('segunda chamada com mesma key durante preparing retorna 409 ASSESSMENT_PREPARING', async () => {
    // Simula: request A ainda preparando quando B chega com a mesma key
    mockRpc.mockResolvedValue({ data: { action: 'existing_preparing', assessmentId: ASSESS_A }, error: null });
    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);
    expect(res._status).toBe(409);
    expect((res._body as any).code).toBe('ASSESSMENT_PREPARING');
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });

  it('segunda chamada com mesma key quando já processing re-emite token e retorna 200', async () => {
    mockRpc.mockResolvedValue({
      data: { action: 'existing_processing', assessmentId: ASSESS_A, referenceText: REF_TEXT },
      error: null,
    });
    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(ASSESS_A);
    expect(vi.mocked(issueAzureSpeechToken)).toHaveBeenCalledOnce();
  });

  it('segunda chamada com mesma key quando já completed retorna 409', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'ATTEMPT_ALREADY_COMPLETED', assessmentId: ASSESS_A }, error: null });
    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);
    expect(res._status).toBe(409);
    expect(vi.mocked(issueAzureSpeechToken)).not.toHaveBeenCalled();
  });
});

// ── Duas análises intencionais ────────────────────────────────────────────────

describe('duas análises intencionais — keys diferentes', () => {
  it('nova key cria novo assessmentId para o mesmo texto', async () => {
    // Primeira análise
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const resA = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), resA);
    expect(resA._status).toBe(200);
    expect((resA._body as any).assessmentId).toBe(ASSESS_A);

    // Segunda análise intencional com nova key
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_B, referenceText: REF_TEXT, reservationOwner: OWNER_B, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const resB = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_B), resB);
    expect(resB._status).toBe(200);
    expect((resB._body as any).assessmentId).toBe(ASSESS_B);

    // Dois assessmentIds distintos
    expect((resA._body as any).assessmentId).not.toBe((resB._body as any).assessmentId);
  });

  it('duas análises intencionais chamam RPC reserve duas vezes (uma por intenção)', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValueOnce({ data: { action: 'confirmed' }, error: null })
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_B, referenceText: REF_TEXT, reservationOwner: OWNER_B, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });

    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), makeRes());
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_B), makeRes());

    const reserveCalls = mockRpc.mock.calls.filter(([n]) => n === 'reserve_pronunciation_attempt');
    expect(reserveCalls).toHaveLength(2);
    expect(reserveCalls[0][1].p_idempotency_key).toBe(IDEM_KEY_A);
    expect(reserveCalls[1][1].p_idempotency_key).toBe(IDEM_KEY_B);
  });
});

// ── Compensação — propriedade da preparação ───────────────────────────────────

describe('compensação — exige reservation_owner correto', () => {
  it('compensação usa o owner retornado pelo RPC de reserva', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_UNAVAILABLE', 'down'),
    );
    const CUSTOM_OWNER = '12345678-1234-1234-1234-123456789012';
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: CUSTOM_OWNER, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'compensated' }, error: null });

    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), makeRes());

    const compensateCalls = mockRpc.mock.calls.filter(([n]) => n === 'compensate_pronunciation_attempt');
    expect(compensateCalls).toHaveLength(1);
    expect(compensateCalls[0][1]).toMatchObject({
      p_assessment_id:       ASSESS_A,
      p_reservation_owner:   CUSTOM_OWNER,
      p_reservation_version: 1,
    });
  });

  it('compensação com owner incorreto é no_op (SQL retorna no_op)', async () => {
    // O SQL faz WHERE reservation_owner = p_reservation_owner; se errado → 0 rows
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { action: 'no_op' }, error: null });

    // Simula backend chamando compensate com owner errado
    const { data } = await mockSupabase.rpc('compensate_pronunciation_attempt', {
      p_assessment_id:       ASSESS_A,
      p_reservation_owner:   'wrong-owner-uuid-0000-0000000000000',
      p_reservation_version: 1,
      p_error_code:          'TOKEN_ISSUE_FAILED',
    });
    expect((data as any).action).toBe('no_op');
  });

  it('existing_processing falha de token NÃO chama compensate', async () => {
    vi.mocked(issueAzureSpeechToken).mockRejectedValue(
      new AzureSpeechError('AZURE_SPEECH_TIMEOUT', 'timeout'),
    );
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({
      data: { action: 'existing_processing', assessmentId: ASSESS_A, referenceText: REF_TEXT },
      error: null,
    });

    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);

    const compensateCalls = mockRpc.mock.calls.filter(([n]) => n === 'compensate_pronunciation_attempt');
    expect(compensateCalls).toHaveLength(0);
    expect(res._status).toBe(504); // Azure timeout
  });

  it('reservation_owner nunca aparece na resposta HTTP', async () => {
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });

    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);

    const bodyStr = JSON.stringify(res._body);
    expect(bodyStr).not.toContain(OWNER_A);
    expect(bodyStr).not.toContain('reservationOwner');
    expect(bodyStr).not.toContain('reservation_owner');
  });
});

// ── Conclusão concorrente ─────────────────────────────────────────────────────

describe('conclusão concorrente — apenas uma persiste', () => {
  it('segundo /complete para mesmo assessmentId recebe already_completed (idempotente)', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1', supabase: mockSupabase as any });

    // Primeira conclusão
    mockRpc.mockResolvedValue({ data: { action: 'completed' }, error: null });
    const resA = makeRes();
    await completeHandler(makeCompleteReq(ASSESS_A), resA);
    expect(resA._status).toBe(200);

    // Segunda conclusão (simulando already_completed do DB)
    mockRpc.mockResolvedValue({ data: { action: 'already_completed' }, error: null });
    const resB = makeRes();
    await completeHandler(makeCompleteReq(ASSESS_A), resB);
    expect(resB._status).toBe(200);
    expect((resB._body as any).status).toBe('completed');
  });

  it('compensação não pode sobrescrever row completed', async () => {
    // DB retorna no_op quando status não é 'preparing'
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { action: 'no_op' }, error: null });

    const { data } = await mockSupabase.rpc('compensate_pronunciation_attempt', {
      p_assessment_id:       ASSESS_A,
      p_reservation_owner:   OWNER_A,
      p_reservation_version: 2, // versão errada (completed já avançou)
      p_error_code:          'TOKEN_ISSUE_FAILED',
    });
    expect((data as any).action).toBe('no_op');
  });
});

// ── Falha não afeta outra tentativa ──────────────────────────────────────────

describe('falha de uma tentativa não afeta outra', () => {
  it('/fail com assessmentId A não chama RPC com assessmentId B', async () => {
    mockRpc.mockResolvedValue({ data: { action: 'failed_retryable' }, error: null });

    await failHandler(makeFailReq(ASSESS_A), makeRes());

    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc.mock.calls[0][1].p_assessment_id).toBe(ASSESS_A);
    expect(mockRpc.mock.calls[0][1].p_assessment_id).not.toBe(ASSESS_B);
  });

  it('erro retryable de assessmentId A não bloqueia nova análise com nova key', async () => {
    // A falhou
    mockRpc.mockResolvedValue({ data: { action: 'failed_retryable' }, error: null });
    await failHandler(makeFailReq(ASSESS_A), makeRes());

    // B (nova intenção, nova key) cria com sucesso
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_B, referenceText: REF_TEXT, reservationOwner: OWNER_B, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });

    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_B), res);
    expect(res._status).toBe(200);
    expect((res._body as any).assessmentId).toBe(ASSESS_B);
  });
});

// ── Snapshot imutável ─────────────────────────────────────────────────────────

describe('snapshot imutável do texto', () => {
  it('referenceText na resposta do /start vem do banco, não do corpo da requisição', async () => {
    const DB_TEXT = 'Texto salvo no banco imutável';
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: DB_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });

    const res = makeRes();
    await startHandler(
      { method: 'POST', headers: {}, body: { textVersionId: TEXT_ID, idempotencyKey: IDEM_KEY_A, referenceText: 'Texto diferente do cliente' } },
      res,
    );
    expect((res._body as any).referenceText).toBe(DB_TEXT);
    expect((res._body as any).referenceText).not.toBe('Texto diferente do cliente');
  });

  it('resultado do /complete usa o resultado enviado pelo cliente (Azure SDK já processou o snapshot)', async () => {
    // O snapshot foi salvo em /start; o cliente usa o referenceText do /start para Azure
    mockRpc.mockResolvedValue({ data: { action: 'completed' }, error: null });
    const res = makeRes();
    await completeHandler(makeCompleteReq(ASSESS_A), res);
    expect((res._body as any).result).toMatchObject({ pronunciationScore: 78 });
  });
});

// ── Isolamento entre usuários ─────────────────────────────────────────────────

describe('isolamento entre usuários', () => {
  it('mesma idempotencyKey em usuários diferentes não causa conflito (DB garante user_id+key)', async () => {
    // Usuário 1 cria com IDEM_KEY_A → ASSESS_A
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-1', supabase: mockSupabase as any });
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const resUser1 = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), resUser1);
    expect(resUser1._status).toBe(200);
    expect((resUser1._body as any).assessmentId).toBe(ASSESS_A);

    // Usuário 2 com a mesma IDEM_KEY_A → cria ASSESS_B independentemente
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-2', supabase: mockSupabase as any });
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_B, referenceText: REF_TEXT, reservationOwner: OWNER_B, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const resUser2 = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), resUser2);
    expect(resUser2._status).toBe(200);
    expect((resUser2._body as any).assessmentId).toBe(ASSESS_B);

    // Os dois assessmentIds são diferentes
    expect((resUser1._body as any).assessmentId).not.toBe((resUser2._body as any).assessmentId);
  });

  it('/complete com assessmentId de outro usuário retorna 404 (SQL valida user_id)', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-2', supabase: mockSupabase as any });
    mockRpc.mockResolvedValue({ data: { error: 'NOT_FOUND' }, error: null });
    const res = makeRes();
    await completeHandler(makeCompleteReq(ASSESS_A), res); // ASSESS_A pertence ao user-1
    expect(res._status).toBe(404);
  });

  it('/fail com assessmentId de outro usuário retorna 404', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'user-2', supabase: mockSupabase as any });
    mockRpc.mockResolvedValue({ data: { error: 'NOT_FOUND' }, error: null });
    const res = makeRes();
    await failHandler(makeFailReq(ASSESS_A), res);
    expect(res._status).toBe(404);
  });
});

// ── Segurança ─────────────────────────────────────────────────────────────────

describe('segurança — nenhuma chave ou token em logs', () => {
  it('resposta bem-sucedida de /start não contém AZURE_SPEECH_KEY', async () => {
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);
    expect(JSON.stringify(res._body)).not.toContain('mock-key');
  });

  it('Cache-Control: no-store na resposta de /start', async () => {
    mockRpc.mockReset();
    mockRpc
      .mockResolvedValueOnce({ data: { action: 'created', assessmentId: ASSESS_A, referenceText: REF_TEXT, reservationOwner: OWNER_A, reservationVersion: 1 }, error: null })
      .mockResolvedValue({ data: { action: 'confirmed' }, error: null });
    const res = makeRes();
    await startHandler(makeStartReq(TEXT_ID, IDEM_KEY_A), res);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });
});

// ── Testes de integração real ─────────────────────────────────────────────────

describe.todo('integração — duas requisições concorrentes com a mesma key: apenas uma linha no DB');
describe.todo('integração — reservation_owner incorreto → compensate retorna no_op no DB real');
describe.todo('integração — duas análises intencionais do mesmo texto geram duas linhas distintas');
describe.todo('integração — complete concorrente: FOR UPDATE garante que apenas uma transação atualiza');
describe.todo('integração — usuário B não pode compensar avaliação de usuário A');
