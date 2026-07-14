import { requireAuth } from '../_auth';
import { isValidUuid } from '../../src/lib/pronunciationAssessment';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import { methodGuard } from '../_helpers';

type ReserveResult = {
  action?: 'created' | 'existing_preparing' | 'existing_processing';
  error?: string;
  assessmentId?: string;
  referenceText?: string;
  reservationOwner?: string;
  reservationVersion?: number;
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
  if (!methodGuard(req, res, ['POST'])) return;

  // ── 1. Authenticate ─────────────────────────────────────────────────────────
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  // ── 2. Validate payload ─────────────────────────────────────────────────────
  const body = req.body ?? {};
  const { textVersionId, idempotencyKey } = body;

  if (!textVersionId || typeof textVersionId !== 'string' || !isValidUuid(textVersionId)) {
    return res.status(400).json({
      code: 'INVALID_TEXT_VERSION_ID',
      message: 'A versão do texto informada é inválida.',
    });
  }

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !isValidUuid(idempotencyKey)) {
    return res.status(400).json({
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: 'A chave de idempotência é inválida.',
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
    'reserve_pronunciation_attempt',
    {
      p_text_version_id: textVersionId,
      p_azure_region:    azureRegion,
      p_idempotency_key: idempotencyKey,
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
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  }
  if (result.error === 'INVALID_IDEMPOTENCY_KEY') {
    return res.status(400).json({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'A chave de idempotência é inválida.' });
  }
  if (result.error === 'TEXT_VERSION_NOT_FOUND') {
    return res.status(404).json({ code: 'TEXT_VERSION_NOT_FOUND', message: 'A versão final do texto não foi encontrada.' });
  }
  if (result.error === 'TEXT_VERSION_NOT_ELIGIBLE') {
    return res.status(409).json({ code: 'TEXT_VERSION_NOT_ELIGIBLE', message: 'Finalize e salve o texto antes de solicitar a análise.' });
  }
  if (result.error === 'ATTEMPT_ALREADY_COMPLETED') {
    return res.status(409).json({
      code: 'ATTEMPT_ALREADY_COMPLETED',
      message: 'Esta tentativa já foi concluída. Inicie uma nova gravação para nova análise.',
      assessmentId: result.assessmentId,
    });
  }
  if (result.error === 'ATTEMPT_ALREADY_FAILED') {
    return res.status(409).json({
      code: 'ATTEMPT_ALREADY_FAILED',
      message: 'Esta tentativa já foi encerrada. Inicie uma nova gravação para nova análise.',
      assessmentId: result.assessmentId,
    });
  }

  // Same idempotency_key, first request still preparing the slot
  if (result.action === 'existing_preparing') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(409).json({
      code: 'ASSESSMENT_PREPARING',
      message: 'A análise está sendo preparada. Tente novamente em instantes.',
      assessmentId: result.assessmentId,
    });
  }

  if (result.error) {
    console.error('[pronunciation/start] Unexpected reservation result:', result.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao reservar a avaliação.' });
  }

  const assessmentId  = result.assessmentId as string;
  const referenceText = result.referenceText as string;
  const isCreator     = result.action === 'created';

  // ── 6. Issue Azure token ────────────────────────────────────────────────────
  // For 'created': confirm preparation after success; compensate on failure.
  // For 'existing_processing': re-issue for lost response; never compensate.
  let tokenResult: Awaited<ReturnType<typeof issueAzureSpeechToken>>;
  try {
    tokenResult = await issueAzureSpeechToken();
  } catch (err) {
    if (isCreator && assessmentId) {
      // Compensation: only the creator can roll back the preparing slot
      const errorCode = err instanceof AzureSpeechError ? err.code : 'TOKEN_ISSUE_FAILED';
      const reservationOwner   = result.reservationOwner;
      const reservationVersion = result.reservationVersion;
      if (reservationOwner && reservationVersion != null) {
        try {
          await supabase.rpc('compensate_pronunciation_attempt', {
            p_assessment_id:       assessmentId,
            p_reservation_owner:   reservationOwner,
            p_reservation_version: reservationVersion,
            p_error_code:          errorCode,
          });
        } catch (compensateErr) {
          console.error(
            '[pronunciation/start] Compensation RPC failed:',
            compensateErr instanceof Error ? compensateErr.message : 'unknown',
          );
        }
      }
    }
    // For 'existing_processing': token failure is a transient error only — the
    // assessment remains processing so the browser can retry later.

    if (err instanceof AzureSpeechError) {
      return res.status(AZURE_ERROR_STATUS[err.code] ?? 503).json({
        configured: false,
        code: err.code,
        message: AZURE_ERROR_MESSAGES[err.code] ?? AZURE_ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE,
      });
    }
    console.error('[pronunciation/start] Unexpected token error:', err instanceof Error ? err.message : 'unknown');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao preparar a análise.' });
  }

  // ── 7. Confirm preparation (only for newly created slots) ───────────────────
  if (isCreator) {
    try {
      await supabase.rpc('confirm_pronunciation_preparation', {
        p_assessment_id:       assessmentId,
        p_reservation_owner:   result.reservationOwner,
        p_reservation_version: result.reservationVersion,
      });
    } catch (confirmErr) {
      // Best effort: assessment stays in 'preparing'; browser retry will resolve it
      console.error('[pronunciation/start] Confirm RPC failed:', confirmErr instanceof Error ? confirmErr.message : 'unknown');
    }
  }

  // ── 8. Respond — Cache-Control: no-store protects the temporary token ────────
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    assessmentId,
    token:         tokenResult.token,
    region:        tokenResult.region,
    language:      'en-US',
    referenceText,
  });
}
