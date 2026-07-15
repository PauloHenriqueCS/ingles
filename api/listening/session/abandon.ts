/**
 * POST /api/listening/session/abandon
 * Body: { sessionId: string }
 * Marks a block session as abandoned (user exited before answering correctly).
 */

import { requireAuth } from '../../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog } from '../../_helpers';
import { getListeningServiceClient } from '../../../src/services/listening/publication/_supabase';
import { abandonListeningSession } from '../../../src/services/listening/execution/abandon-listening-session';
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
    await abandonListeningSession(serviceClient, sessionId, userId);

    safeLog('listening/session/abandon', 'session_abandoned', 200, { sessionId });
    return res.status(200).json({ sessionId, status: 'abandoned' });
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND) {
        return jsonError(res, 404, err.code, 'Sessão não encontrada.');
      }
      safeLog('listening/session/abandon', 'execution_error', 500, { sessionId, code: err.code });
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
