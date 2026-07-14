import { requireAuth } from '../_auth';
import { isValidUuid } from '../../src/lib/pronunciationAssessment';
import type { PronunciationNormalizedResult } from '../../src/types';
import { methodGuard } from '../_helpers';

// Maximum request body size accepted (generous for words/phonemes JSON, still bounded)
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

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

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  const raw = req.body ?? {};

  // Guard against oversized payloads
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload muito grande.' });
  }

  const { assessmentId, result } = raw;

  if (!isValidUuid(assessmentId)) {
    return res.status(400).json({ code: 'INVALID_ASSESSMENT_ID', message: 'assessmentId inválido.' });
  }
  if (!validateResult(result)) {
    return res.status(400).json({ code: 'INVALID_RESULT', message: 'Resultado inválido ou fora do intervalo permitido.' });
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'complete_pronunciation_assessment',
    {
      p_assessment_id:       assessmentId,
      p_pronunciation_score: result.pronunciationScore,
      p_accuracy_score:      result.accuracyScore,
      p_fluency_score:       result.fluencyScore,
      p_completeness_score:  result.completenessScore,
      p_prosody_score:       result.prosodyScore ?? null,
      p_recognized_text:     result.recognizedText,
      p_words_json:          result.wordsJson,
      p_raw_result_json:     result.rawSegments,
      p_audio_duration_s:    result.audioDurationSeconds,
    },
  );

  if (rpcError) {
    console.error('[pronunciation/complete] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao salvar o resultado.' });
  }

  const rpc = (rpcData ?? {}) as Record<string, unknown>;

  if (rpc.error === 'UNAUTHORIZED') {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  }
  if (rpc.error === 'NOT_FOUND') {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Avaliação não encontrada.' });
  }
  if (rpc.error === 'ASSESSMENT_NOT_PROCESSING') {
    return res.status(409).json({ code: 'ASSESSMENT_NOT_PROCESSING', message: 'Esta avaliação não está em processamento.' });
  }
  if (rpc.error) {
    console.error('[pronunciation/complete] Unexpected RPC result:', rpc.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno ao salvar o resultado.' });
  }

  res.setHeader('Cache-Control', 'no-store');

  // 'already_completed' is idempotent — return the submitted result
  return res.status(200).json({
    assessmentId,
    status: 'completed',
    result,
  });
}
