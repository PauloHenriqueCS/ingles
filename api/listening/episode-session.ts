/**
 * GET /api/listening/episode-session?episodeId=UUID
 * Returns a session-aware view of a published episode.
 * Creates or resumes block sessions; block 2 locked until block 1 is completed.
 */

import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog } from '../_helpers';
import { canUserAccessListeningEpisode } from '../../src/services/listening/publication/authorize-listening-access';
import { buildListeningEpisodeSession } from '../../src/services/listening/execution/build-listening-episode-session';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from '../../src/services/listening/execution/listening-execution-types';
import { LISTENING_ERRORS } from '../../src/services/listening/publication/listening-publication-types';

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const episodeId = String(req.query?.episodeId ?? '').trim();
  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(episodeId)) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  }

  const access = await canUserAccessListeningEpisode(supabase, { userId, episodeId });
  if (!access.allowed) {
    safeLog('listening/episode-session', 'access_denied', 403, { episodeId });
    if (access.reason === 'episode_not_found') {
      return jsonError(res, 404, LISTENING_ERRORS.EPISODE_NOT_FOUND, 'Episódio não encontrado.');
    }
    return jsonError(res, 403, LISTENING_ERRORS.ACCESS_DENIED, 'Acesso negado.');
  }

  try {
    const data = await buildListeningEpisodeSession(episodeId, userId, supabase);

    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/episode-session', 'session_delivered', 200, { episodeId });
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.EPISODE_NOT_FOUND) {
        return jsonError(res, 404, err.code, 'Episódio não encontrado.');
      }
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_CONFLICT && err.retryable) {
        return jsonError(res, 409, err.code, 'Conflito ao criar sessão — tente novamente.');
      }
      safeLog('listening/episode-session', 'execution_error', 500, { episodeId, code: err.code });
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao carregar sessão do episódio.');
    }
    safeLog('listening/episode-session', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
