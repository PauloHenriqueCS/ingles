import { requireAuth } from '../_auth';
import { isValidUuid } from '../../src/lib/pronunciationAssessment';
import type { PronunciationFailCode } from '../../src/types';
import { methodGuard } from '../_helpers';

const ALLOWED_CODES = new Set<PronunciationFailCode>([
  'AUDIO_DECODE_FAILED',
  'AUDIO_EMPTY',
  'AZURE_NO_MATCH',
  'AZURE_CANCELED',
  'AZURE_TIMEOUT',
  'AZURE_NETWORK_ERROR',
  'RESULT_INVALID',
  'CLIENT_INTERRUPTED',
]);

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;

  const body = req.body ?? {};
  const { assessmentId, attemptId, code } = body;

  if (!isValidUuid(assessmentId)) {
    return res.status(400).json({ code: 'INVALID_ASSESSMENT_ID', message: 'assessmentId inválido.' });
  }
  if (!isValidUuid(attemptId)) {
    return res.status(400).json({ code: 'INVALID_ATTEMPT_ID', message: 'attemptId inválido.' });
  }
  if (typeof code !== 'string' || !ALLOWED_CODES.has(code as PronunciationFailCode)) {
    return res.status(400).json({ code: 'INVALID_ERROR_CODE', message: 'Código de erro não permitido.' });
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'fail_pronunciation_assessment',
    {
      p_assessment_id: assessmentId,
      p_attempt_id:    attemptId,
      p_error_code:    code,
    },
  );

  if (rpcError) {
    console.error('[pronunciation/fail] RPC error:', rpcError.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }

  const rpc = (rpcData ?? {}) as Record<string, unknown>;

  if (rpc.error === 'UNAUTHORIZED') {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Faça login para continuar.' });
  }
  if (rpc.error === 'NOT_FOUND') {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Avaliação não encontrada.' });
  }
  if (rpc.error) {
    console.error('[pronunciation/fail] Unexpected RPC result:', rpc.error);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
  }

  // 'no_op' means completed or stale attempt — both are safe outcomes
  return res.status(200).json({ status: rpc.action ?? 'no_op' });
}
