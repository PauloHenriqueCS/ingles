/**
 * GET /api/listening/episode?episodeId=UUID
 * Retorna dados públicos de um episódio publicado com URLs assinadas.
 * Nunca retorna: correctOption, SSML, hashes internos, paths de staging.
 */

import { requireAuth } from '../_auth';
import { methodGuard, jsonError, safeLog } from '../_helpers';
import { canUserAccessListeningEpisode } from '../../src/services/listening/publication/authorize-listening-access';
import { buildPublicListeningEpisode } from '../../src/services/listening/publication/build-public-listening-episode';
import { LISTENING_ERRORS, ListeningPublicationError } from '../../src/services/listening/publication/listening-publication-types';

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
    safeLog('listening/episode', 'access_denied', 403, { episodeId, reason: access.reason ?? 'denied' });
    if (access.reason === 'episode_archived') {
      return jsonError(res, 404, LISTENING_ERRORS.EPISODE_ARCHIVED, 'Episódio não disponível.');
    }
    if (access.reason === 'episode_not_found') {
      return jsonError(res, 404, LISTENING_ERRORS.EPISODE_NOT_FOUND, 'Episódio não encontrado.');
    }
    return jsonError(res, 403, LISTENING_ERRORS.ACCESS_DENIED, 'Acesso negado.');
  }

  try {
    const data = await buildPublicListeningEpisode(episodeId, userId, supabase);

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/json');
    safeLog('listening/episode', 'episode_delivered', 200, { episodeId });
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof ListeningPublicationError) {
      if (err.code === LISTENING_ERRORS.EPISODE_NOT_FOUND) {
        return jsonError(res, 404, err.code, 'Episódio não encontrado.');
      }
      if (err.code === LISTENING_ERRORS.ACCESS_DENIED || err.code === LISTENING_ERRORS.EPISODE_ARCHIVED) {
        return jsonError(res, 403, err.code, 'Acesso negado.');
      }
      safeLog('listening/episode', 'publication_error', 500, { episodeId, code: err.code });
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao carregar episódio.');
    }
    safeLog('listening/episode', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
