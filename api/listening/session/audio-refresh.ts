/**
 * POST /api/listening/session/audio-refresh
 * Body: { sessionId: string }
 * Generates a fresh signed URL for the audio of an active block session.
 */

import { requireAuth } from '../../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog } from '../../_helpers';
import { getListeningServiceClient } from '../../../src/services/listening/publication/_supabase';
import { createListeningAudioSignedUrl } from '../../../src/services/listening/publication/create-listening-signed-url';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from '../../../src/services/listening/execution/listening-execution-types';
import { ListeningPublicationError } from '../../../src/services/listening/publication/listening-publication-types';

const MAX_BODY_BYTES = 256;

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, MAX_BODY_BYTES)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  }

  try {
    const serviceClient = getListeningServiceClient();

    // Load session to get episodeId and blockId.
    const { data: session, error: sessionError } = await serviceClient
      .from('user_listening_block_sessions')
      .select('id, user_id, episode_id, block_id, status, expires_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (sessionError || !session) {
      return jsonError(res, 404, LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND, 'Sessão não encontrada.');
    }

    if (new Date(session.expires_at) <= new Date()) {
      return jsonError(res, 410, LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED, 'Sessão expirada.');
    }

    if (session.status === 'completed' || session.status === 'abandoned') {
      return jsonError(res, 409, LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE, 'Sessão encerrada.');
    }

    const signed = await createListeningAudioSignedUrl(
      { userId, episodeId: session.episode_id, blockId: session.block_id },
      supabase,
    );

    safeLog('listening/session/audio-refresh', 'url_refreshed', 200, { sessionId });
    return res.status(200).json({
      sessionId,
      url: signed.url,
      expiresAt: signed.expiresAt,
      durationMs: signed.durationMs,
    });
  } catch (err) {
    if (err instanceof ListeningPublicationError) {
      safeLog('listening/session/audio-refresh', 'signed_url_failed', 500, { sessionId, code: err.code });
      return jsonError(res, 500, err.code, 'Não foi possível renovar a URL do áudio.');
    }
    if (err instanceof ListeningExecutionError) {
      return jsonError(res, 500, err.code, 'Erro ao renovar URL de áudio.');
    }
    safeLog('listening/session/audio-refresh', 'internal_error', 500, { sessionId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
