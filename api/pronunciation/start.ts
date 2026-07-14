import { requireAuth } from '../_auth';
import { isValidUuid } from '../../src/lib/pronunciationAssessment';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';

type ReserveResult = {
  action?: 'created' | 'reactivated' | 'existing_processing';
  error?: string;
  assessmentId?: string;
  referenceText?: string;
};

const AZURE_ERROR_STATUS: Record<string, number> = {
  AZURE_SPEECH_NOT_CONFIGURED: 503,
  AZURE_SPEECH_AUTH_FAILED: 503,
  AZURE_SPEECH_TIMEOUT: 504,
  AZURE_SPEECH_RATE_LIMITED: 503,
  AZURE_SPEECH_UNAVAILABLE: 503,
};

const AZURE_ERROR_MESSAGES: Record<string, string> = {
  AZURE_SPEECH_NOT_CONFIGURED: 'O serviço de pronúncia ainda não está configurado.',
  AZURE_SPEECH_AUTH_FAILED: 'Não foi possível autenticar o serviço de pronúncia.',
  AZURE_SPEECH_TIMEOUT: 'O serviço de pronúncia demorou para responder.',
  AZURE_SPEECH_RATE_LIMITED: 'O serviço de pronúncia está temporariamente indisponível.',
  AZURE_SPEECH_UNAVAILABLE: 'O serviço de pronúncia está temporariamente indisponível.',
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── 1. Authenticate ─────────────────────────────────────────────────────────
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  // ── 2. Validate payload ─────────────────────────────────────────────────────
  const body = req.body ?? {};
  const { textVersionId, attemptId } = body;

  if (!textVersionId || typeof textVersionId !== 'string' || !isValidUuid(textVersionId)) {
    return res.status(400).json({
      code: 'INVALID_TEXT_VERSION_ID',
      message: 'A versão do texto informada é inválida.',
    });
  }

  if (!attemptId || typeof attemptId !== 'string' || !isValidUuid(attemptId)) {
    return res.status(400).json({
      code: 'INVALID_ATTEMPT_ID',
      message: 'O identificador de tentativa é inválido.',
    });
  }

  // ── 3. Fail fast if Azure is not configured ──────────────────────────────────
  const azureRegion = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!azureRegion) {
    return res.status(503).json({
      code: 'AZURE_SPEECH_NOT_CONFIGURED',
      message: AZURE_ERROR_MESSAGES.AZURE_SPEECH_NOT_CONFIGURED,
    });
  }

  // ── 4. Reserve atomically via SECURITY DEFINER RPC ──────────────────────────
  const { data: reserveData, error: rpcError } = await supabase.rpc(
    'reserve_pronunciation_assessment',
    {
      p_text_version_id: textVersionId,
      p_azure_region: azureRegion,
      p_attempt_id: attemptId,
    },
  );

  if (rpcError) {
    console.error('[pronunciation/start] RPC error:', rpcError.message);
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno ao reservar a avaliação.',
    });
  }

  const result = (reserveData ?? {}) as ReserveResult;

  // ── 5. Interpret reservation result ─────────────────────────────────────────
  if (result.error === 'UNAUTHORIZED') {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'Faça login para continuar.',
    });
  }

  if (result.error === 'TEXT_VERSION_NOT_FOUND') {
    return res.status(404).json({
      code: 'TEXT_VERSION_NOT_FOUND',
      message: 'A versão final do texto não foi encontrada.',
    });
  }

  if (result.error === 'TEXT_VERSION_NOT_ELIGIBLE') {
    return res.status(409).json({
      code: 'TEXT_VERSION_NOT_ELIGIBLE',
      message: 'Finalize e salve o texto antes de solicitar a análise.',
    });
  }

  if (result.error === 'ASSESSMENT_ALREADY_COMPLETED') {
    return res.status(409).json({
      code: 'ASSESSMENT_ALREADY_COMPLETED',
      message: 'Este texto já possui uma análise de pronúncia.',
      assessmentId: result.assessmentId,
    });
  }

  if (result.error === 'ASSESSMENT_NOT_RETRYABLE') {
    return res.status(409).json({
      code: 'ASSESSMENT_NOT_RETRYABLE',
      message: 'Esta avaliação não pode ser reiniciada.',
      assessmentId: result.assessmentId,
    });
  }

  if (result.error === 'ASSESSMENT_IN_PROGRESS') {
    return res.status(409).json({
      code: 'ASSESSMENT_IN_PROGRESS',
      message: 'Já existe uma análise em andamento para este texto.',
      assessmentId: result.assessmentId,
    });
  }

  if (result.error) {
    console.error('[pronunciation/start] Unexpected reservation result:', result.error);
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno ao reservar a avaliação.',
    });
  }

  const assessmentId = result.assessmentId as string;
  const referenceText = result.referenceText as string;

  // All three success actions mean we can (and should) issue a token:
  // - 'created': we just created the slot with our attempt
  // - 'reactivated': we reactivated a failed slot with our attempt
  // - 'existing_processing': same attemptId called /start again (e.g. token expired)
  // Only a DIFFERENT attemptId would have returned ASSESSMENT_IN_PROGRESS above.
  const isOurSlot =
    result.action === 'created' ||
    result.action === 'reactivated' ||
    result.action === 'existing_processing';

  // ── 6. Issue token (only after reservation is confirmed) ────────────────────
  let tokenResult: Awaited<ReturnType<typeof issueAzureSpeechToken>>;
  try {
    tokenResult = await issueAzureSpeechToken();
  } catch (err) {
    if (isOurSlot && assessmentId) {
      const errorCode = err instanceof AzureSpeechError ? err.code : 'TOKEN_ISSUE_FAILED';
      const errorMessage = 'Falha ao emitir credencial temporária de pronúncia.';
      try {
        await supabase.rpc('compensate_pronunciation_assessment', {
          p_assessment_id: assessmentId,
          p_error_code: errorCode,
          p_error_message: errorMessage,
        });
      } catch (compensateErr) {
        console.error(
          '[pronunciation/start] Compensation RPC failed:',
          compensateErr instanceof Error ? compensateErr.message : 'unknown',
        );
      }
    }

    if (err instanceof AzureSpeechError) {
      return res.status(AZURE_ERROR_STATUS[err.code] ?? 503).json({
        configured: false,
        code: err.code,
        message: AZURE_ERROR_MESSAGES[err.code] ?? AZURE_ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE,
      });
    }

    console.error(
      '[pronunciation/start] Unexpected token error:',
      err instanceof Error ? err.message : 'unknown',
    );
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno ao preparar a análise.',
    });
  }

  // ── 7. Respond — Cache-Control: no-store protects the temporary token ────────
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    assessmentId,
    attemptId,
    token: tokenResult.token,
    region: tokenResult.region,
    language: 'en-US',
    referenceText,
  });
}
