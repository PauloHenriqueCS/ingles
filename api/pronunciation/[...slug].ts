import { requireAuth } from '../_auth';
import { isValidUuid, buildStatusResponse, rowToAssessment } from '../../src/lib/pronunciationAssessment';
import { issueAzureSpeechToken, AzureSpeechError } from '../_azure-speech';
import type { PronunciationNormalizedResult, PronunciationFailCode } from '../../src/types';
import { methodGuard, safeLog } from '../_helpers';

// ─── start ────────────────────────────────────────────────────────────────────

type ReserveResult = {
  action?: 'created' | 'reactivated' | 'existing_processing' | 'restarted';
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

async function handleStart(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const body = req.body ?? {};
  const { textVersionId, attemptId } = body;
  if (!textVersionId || typeof textVersionId !== 'string' || !isValidUuid(textVersionId)) {
    return res.status(400).json({ code: 'INVALID_TEXT_VERSION_ID', message: 'A versão do texto informada é inválida.' });
  }
  if (!attemptId || typeof attemptId !== 'string' || !isValidUuid(attemptId)) {
    return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'O identificador de tentativa é inválido.' });
  }
  const azureRegion = (process.env.AZURE_SPEECH_REGION ?? '').trim();
  if (!azureRegion) {
    return res.status(503).json({ code: 'AZURE_SPEECH_NOT_CONFIGURED', message: AZURE_ERROR_MESSAGES.AZURE_SPEECH_NOT_CONFIGURED });
  }
  const { data: reserveData, error: rpcError } = await supabase.rpc('reserve_pronunciation_assessment', {
    p_text_version_id: textVersionId, p_azure_region: azureRegion, p_attempt_id: attemptId,
  });
  if (rpcError) {
    console.error('[pronunciation/start] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao reservar a avaliação.' });
  }
  const result = (reserveData ?? {}) as ReserveResult;
  if (result.error === 'UNAUTHORIZED') return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  if (result.error === 'TEXT_VERSION_NOT_FOUND') return res.status(404).json({ code: 'TEXT_VERSION_NOT_FOUND', message: 'A versão final do texto não foi encontrada.' });
  if (result.error === 'TEXT_VERSION_NOT_ELIGIBLE') return res.status(409).json({ code: 'TEXT_VERSION_NOT_ELIGIBLE', message: 'Finalize e salve o texto antes de solicitar a análise.' });
  if (result.error === 'ASSESSMENT_ALREADY_COMPLETED') return res.status(409).json({ code: 'ASSESSMENT_ALREADY_COMPLETED', message: 'Este texto já possui uma análise de pronúncia.', assessmentId: result.assessmentId });
  if (result.error === 'ASSESSMENT_NOT_RETRYABLE') return res.status(409).json({ code: 'ASSESSMENT_NOT_RETRYABLE', message: 'Esta avaliação não pode ser reiniciada.', assessmentId: result.assessmentId });
  if (result.error === 'ASSESSMENT_IN_PROGRESS') return res.status(409).json({ code: 'ASSESSMENT_IN_PROGRESS', message: 'Já existe uma análise em andamento para este texto.', assessmentId: result.assessmentId });
  if (result.error) {
    console.error('[pronunciation/start] Unexpected reservation result:', result.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao reservar a avaliação.' });
  }
  const assessmentId = result.assessmentId as string;
  const referenceText = result.referenceText as string;
  const isOurSlot = result.action === 'created' || result.action === 'reactivated' || result.action === 'existing_processing' || result.action === 'restarted';
  let tokenResult: Awaited<ReturnType<typeof issueAzureSpeechToken>>;
  try {
    tokenResult = await issueAzureSpeechToken();
  } catch (err) {
    if (isOurSlot && assessmentId) {
      const errorCode = err instanceof AzureSpeechError ? err.code : 'TOKEN_ISSUE_FAILED';
      try {
        await supabase.rpc('compensate_pronunciation_assessment', { p_assessment_id: assessmentId, p_error_code: errorCode, p_error_message: 'Falha ao emitir credencial temporária de pronúncia.' });
      } catch (compensateErr) {
        console.error('[pronunciation/start] Compensation RPC failed:', compensateErr instanceof Error ? compensateErr.message : 'unknown');
      }
    }
    if (err instanceof AzureSpeechError) {
      return res.status(AZURE_ERROR_STATUS[err.code] ?? 503).json({ configured: false, code: err.code, message: AZURE_ERROR_MESSAGES[err.code] ?? AZURE_ERROR_MESSAGES.AZURE_SPEECH_UNAVAILABLE });
    }
    console.error('[pronunciation/start] Unexpected token error:', err instanceof Error ? err.message : 'unknown');
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao preparar a análise.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ assessmentId, attemptId, token: tokenResult.token, region: tokenResult.region, language: 'en-US', referenceText });
}

// ─── complete ─────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES_COMPLETE = 2 * 1024 * 1024;

function isFiniteScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}
function validateResult(r: unknown): r is PronunciationNormalizedResult {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (!isFiniteScore(o.pronunciationScore)) return false;
  if (!isFiniteScore(o.accuracyScore)) return false;
  if (!isFiniteScore(o.fluencyScore)) return false;
  if (!isFiniteScore(o.completenessScore)) return false;
  if (o.prosodyScore !== null && !isFiniteScore(o.prosodyScore)) return false;
  if (typeof o.recognizedText !== 'string' || o.recognizedText.length > 50_000) return false;
  if (!Array.isArray(o.wordsJson) || o.wordsJson.length > 5_000) return false;
  if (!Array.isArray(o.rawSegments) || o.rawSegments.length > 1_000) return false;
  if (typeof o.audioDurationSeconds !== 'number' || !Number.isFinite(o.audioDurationSeconds)) return false;
  return true;
}

async function handleComplete(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const raw = req.body ?? {};
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES_COMPLETE) {
    return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload muito grande.' });
  }
  const { assessmentId, attemptId, result } = raw;
  if (!isValidUuid(assessmentId)) return res.status(400).json({ code: 'INVALID_ASSESSMENT_ID', message: 'assessmentId inválido.' });
  if (!isValidUuid(attemptId)) return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'attemptId inválido.' });
  if (!validateResult(result)) return res.status(400).json({ code: 'INVALID_RESULT', message: 'Resultado inválido ou fora do intervalo permitido.' });
  const { data: rpcData, error: rpcError } = await supabase.rpc('complete_pronunciation_assessment', {
    p_assessment_id: assessmentId, p_attempt_id: attemptId,
    p_pronunciation_score: result.pronunciationScore, p_accuracy_score: result.accuracyScore,
    p_fluency_score: result.fluencyScore, p_completeness_score: result.completenessScore,
    p_prosody_score: result.prosodyScore ?? null, p_recognized_text: result.recognizedText,
    p_words_json: result.wordsJson, p_raw_result_json: result.rawSegments,
    p_audio_duration_s: result.audioDurationSeconds,
  });
  if (rpcError) {
    console.error('[pronunciation/complete] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao salvar o resultado.' });
  }
  const rpc = (rpcData ?? {}) as Record<string, unknown>;
  if (rpc.error === 'UNAUTHORIZED') return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  if (rpc.error === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND', message: 'Avaliação não encontrada.' });
  if (rpc.error === 'ASSESSMENT_ALREADY_COMPLETED') return res.status(409).json({ code: 'ASSESSMENT_ALREADY_COMPLETED', message: 'Este texto já possui uma análise concluída.' });
  if (rpc.error === 'ATTEMPT_MISMATCH') return res.status(409).json({ code: 'ATTEMPT_MISMATCH', message: 'Esta tentativa não corresponde à tentativa ativa.' });
  if (rpc.error) {
    console.error('[pronunciation/complete] Unexpected RPC result:', rpc.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao salvar o resultado.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ assessmentId, status: 'completed', result });
}

// ─── fail ─────────────────────────────────────────────────────────────────────

const ALLOWED_CODES = new Set<PronunciationFailCode>([
  'AUDIO_DECODE_FAILED', 'AUDIO_EMPTY', 'AZURE_NO_MATCH', 'AZURE_CANCELED',
  'AZURE_TIMEOUT', 'AZURE_NETWORK_ERROR', 'RESULT_INVALID', 'CLIENT_INTERRUPTED',
]);

async function handleFail(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  const body = req.body ?? {};
  const { assessmentId, attemptId, code } = body;
  if (!isValidUuid(assessmentId)) return res.status(400).json({ code: 'INVALID_ASSESSMENT_ID', message: 'assessmentId inválido.' });
  if (!isValidUuid(attemptId)) return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'attemptId inválido.' });
  if (typeof code !== 'string' || !ALLOWED_CODES.has(code as PronunciationFailCode)) {
    return res.status(400).json({ code: 'INVALID_ERROR_CODE', message: 'Código de erro não permitido.' });
  }
  const { data: rpcData, error: rpcError } = await supabase.rpc('fail_pronunciation_assessment', {
    p_assessment_id: assessmentId, p_attempt_id: attemptId, p_error_code: code,
  });
  if (rpcError) {
    console.error('[pronunciation/fail] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }
  const rpc = (rpcData ?? {}) as Record<string, unknown>;
  if (rpc.error === 'UNAUTHORIZED') return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  if (rpc.error === 'NOT_FOUND') return res.status(404).json({ code: 'NOT_FOUND', message: 'Avaliação não encontrada.' });
  if (rpc.error) {
    console.error('[pronunciation/fail] Unexpected RPC result:', rpc.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }
  return res.status(200).json({ status: rpc.action ?? 'no_op' });
}

// ─── status ───────────────────────────────────────────────────────────────────

async function handleStatus(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { textVersionId } = req.query ?? {};
  if (!isValidUuid(textVersionId)) return res.status(400).json({ error: 'textVersionId inválido.' });
  const { userId, supabase } = auth;
  const { data: review, error: reviewError } = await supabase.from('english_reviews').select('id').eq('id', textVersionId).eq('user_id', userId).maybeSingle();
  if (reviewError) { safeLog('pronunciation/status', 'db_error', 500); return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' }); }
  if (!review) return res.status(404).json({ code: 'NOT_FOUND', message: 'Revisão não encontrada.' });
  const { data: row, error: assessmentError } = await supabase.from('pronunciation_assessments').select('*').eq('text_version_id', textVersionId).eq('user_id', userId).maybeSingle();
  if (assessmentError) { safeLog('pronunciation/status', 'db_error', 500); return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' }); }
  const assessment = row ? rowToAssessment(row as Record<string, unknown>) : null;
  return res.json(buildStatusResponse(assessment));
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  const slug = (Array.isArray(req.query.slug) ? req.query.slug : [req.query.slug ?? '']).join('/');
  switch (slug) {
    case 'start':    return handleStart(req, res);
    case 'complete': return handleComplete(req, res);
    case 'fail':     return handleFail(req, res);
    case 'status':   return handleStatus(req, res);
    default:         return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
