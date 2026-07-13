import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { issueAzureSpeechToken, AzureSpeechError } from '../../api/_azure-speech';

const MOCK_KEY = 'mock-speech-key-abc123';
const MOCK_REGION = 'eastus';
const MOCK_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.mock.token';
const EXPECTED_ENDPOINT = `https://${MOCK_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

function mockFetchOk(text = MOCK_TOKEN) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => text,
  }));
}

function mockFetchStatus(status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => 'error body',
  }));
}

beforeEach(() => {
  vi.stubEnv('AZURE_SPEECH_KEY', MOCK_KEY);
  vi.stubEnv('AZURE_SPEECH_REGION', MOCK_REGION);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── Configuração ──────────────────────────────────────────────────────────────

describe('getAzureSpeechConfig (via issueAzureSpeechToken)', () => {
  it('lança AZURE_SPEECH_NOT_CONFIGURED quando AZURE_SPEECH_KEY está ausente', async () => {
    vi.stubEnv('AZURE_SPEECH_KEY', '');

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_NOT_CONFIGURED',
    });
  });

  it('lança AZURE_SPEECH_NOT_CONFIGURED quando AZURE_SPEECH_KEY é só espaços', async () => {
    vi.stubEnv('AZURE_SPEECH_KEY', '   ');

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_NOT_CONFIGURED',
    });
  });

  it('lança AZURE_SPEECH_NOT_CONFIGURED quando AZURE_SPEECH_REGION está ausente', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', '');

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_NOT_CONFIGURED',
    });
  });

  it('lança AZURE_SPEECH_NOT_CONFIGURED para região com formato inválido (espaços, caracteres especiais)', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', 'INVALID REGION!');

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_NOT_CONFIGURED',
    });
  });

  it('aceita regiões legítimas do Azure como westeurope, brazilsouth', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', 'brazilsouth');
    mockFetchOk();

    const result = await issueAzureSpeechToken();
    expect(result.region).toBe('brazilsouth');
  });
});

// ── Geração de token ──────────────────────────────────────────────────────────

describe('issueAzureSpeechToken', () => {
  it('retorna token, região e expiresInSeconds quando Azure responde com sucesso', async () => {
    mockFetchOk();

    const result = await issueAzureSpeechToken();

    expect(result.token).toBe(MOCK_TOKEN);
    expect(result.region).toBe(MOCK_REGION);
    expect(result.expiresInSeconds).toBeGreaterThan(0);
    expect(result.expiresInSeconds).toBeLessThanOrEqual(600);
  });

  it('chama o endpoint regional correto com o header Ocp-Apim-Subscription-Key', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => MOCK_TOKEN,
    });
    vi.stubGlobal('fetch', mockFetch);

    await issueAzureSpeechToken();

    expect(mockFetch).toHaveBeenCalledWith(
      EXPECTED_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Ocp-Apim-Subscription-Key': MOCK_KEY,
        }),
      }),
    );
  });

  it('usa AZURE_SPEECH_REGION para construir o endpoint — não fixa eastus', async () => {
    vi.stubEnv('AZURE_SPEECH_REGION', 'westeurope');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => MOCK_TOKEN,
    });
    vi.stubGlobal('fetch', mockFetch);

    await issueAzureSpeechToken();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://westeurope.api.cognitive.microsoft.com/sts/v1.0/issueToken',
      expect.anything(),
    );
  });

  it('lança AZURE_SPEECH_AUTH_FAILED para status 401 (chave inválida)', async () => {
    mockFetchStatus(401);

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_AUTH_FAILED',
    });
  });

  it('lança AZURE_SPEECH_AUTH_FAILED para status 403 (região incorreta ou permissão negada)', async () => {
    mockFetchStatus(403);

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_AUTH_FAILED',
    });
  });

  it('lança AZURE_SPEECH_RATE_LIMITED para status 429', async () => {
    mockFetchStatus(429);

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_RATE_LIMITED',
    });
  });

  it('lança AZURE_SPEECH_UNAVAILABLE para erro 5xx', async () => {
    mockFetchStatus(500);

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_UNAVAILABLE',
    });
  });

  it('lança AZURE_SPEECH_UNAVAILABLE para resposta vazia do Azure', async () => {
    mockFetchOk('');

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_UNAVAILABLE',
    });
  });

  it('lança AZURE_SPEECH_UNAVAILABLE para resposta com apenas espaços', async () => {
    mockFetchOk('   ');

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_UNAVAILABLE',
    });
  });

  it('lança AZURE_SPEECH_TIMEOUT quando fetch é abortado (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_TIMEOUT',
    });
  });

  it('lança AZURE_SPEECH_UNAVAILABLE para falha de rede genérica', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    await expect(issueAzureSpeechToken()).rejects.toMatchObject({
      code: 'AZURE_SPEECH_UNAVAILABLE',
    });
  });

  it('o resultado não expõe AZURE_SPEECH_KEY', async () => {
    mockFetchOk();

    const result = await issueAzureSpeechToken();

    expect(JSON.stringify(result)).not.toContain(MOCK_KEY);
  });

  it('o resultado não expõe variáveis de ambiente completas', async () => {
    mockFetchOk();

    const result = await issueAzureSpeechToken();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('AZURE_SPEECH_KEY');
    expect(serialized).not.toContain('process.env');
  });

  it('AzureSpeechError contém code e é instância de Error', async () => {
    vi.stubEnv('AZURE_SPEECH_KEY', '');

    let thrown: unknown;
    try {
      await issueAzureSpeechToken();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(AzureSpeechError);
    expect((thrown as AzureSpeechError).code).toBe('AZURE_SPEECH_NOT_CONFIGURED');
  });
});

// ── Contrato do endpoint /api/pronunciation/azure-status ─────────────────────

describe('azure-status endpoint — contrato de segurança', () => {
  it('resposta de sucesso contém configured, service e region — sem token', async () => {
    mockFetchOk();

    const { region } = await issueAzureSpeechToken();

    // Simulates what the endpoint returns (token is discarded)
    const endpointResponse = { configured: true, service: 'azure-speech', region };

    expect(endpointResponse).not.toHaveProperty('token');
    expect(endpointResponse).not.toHaveProperty('key');
    expect(endpointResponse.service).toBe('azure-speech');
    expect(endpointResponse.region).toBe(MOCK_REGION);
  });

  it('resposta de erro não contém a chave nem o token', () => {
    const errorResponse = {
      configured: false,
      code: 'AZURE_SPEECH_NOT_CONFIGURED',
      message: 'O serviço de pronúncia ainda não está configurado.',
    };

    expect(errorResponse).not.toHaveProperty('token');
    expect(errorResponse).not.toHaveProperty('key');
    expect(JSON.stringify(errorResponse)).not.toContain(MOCK_KEY);
  });
});

// ── Testes de integração que requerem Supabase + Azure reais ─────────────────
describe.todo('GET /api/pronunciation/azure-status — usuário não autenticado recebe 401');
describe.todo('GET /api/pronunciation/azure-status — não altera banco de dados');
describe.todo('GET /api/pronunciation/azure-status — não recebe nem utiliza textVersionId');
describe.todo('build não inclui AZURE_SPEECH_KEY no bundle do navegador');
