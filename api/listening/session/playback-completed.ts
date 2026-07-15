/**
 * POST /api/listening/session/playback-completed
 * Body: { sessionId: string }
 * Transitions a block session from active|replay_required → awaiting_answer.
 * Called when the user finishes playing the audio.
 */

import { requireAuth } from '../../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog } from '../../_helpers';
import { getListeningServiceClient } from '../../../src/services/listening/publication/_supabase';
import { markListeningPlaybackCompleted } from '../../../src/services/listening/execution/mark-listening-playback-completed';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from '../../../src/services/listening/execution/listening-execution-types';

const MAX_BODY_BYTES = 256;

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, MAX_BODY_BYTES)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  }

  try {
    const serviceClient = getListeningServiceClient();
    const session = await markListeningPlaybackCompleted(serviceClient, sessionId, userId);

    safeLog('listening/session/playback-completed', 'playback_marked', 200, { sessionId });
    return res.status(200).json({
      sessionId: session.id,
      status: session.status,
      currentAttempt: session.currentAttempt,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND) {
        return jsonError(res, 404, err.code, 'Sessão não encontrada.');
      }
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED) {
        return jsonError(res, 410, err.code, 'Sessão expirada.');
      }
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE) {
        return jsonError(res, 409, err.code, 'Estado da sessão inválido para esta operação.');
      }
      safeLog('listening/session/playback-completed', 'execution_error', 500, { sessionId, code: err.code });
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
