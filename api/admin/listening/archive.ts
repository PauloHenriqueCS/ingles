/**
 * POST /api/admin/listening/archive
 * Body: { episodeId: string }
 * Arquiva episódio publicado. Mantém dados históricos e progresso.
 */

import { requireAuth } from '../../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog } from '../../_helpers';
import { archiveListeningEpisode } from '../../../src/services/listening/publication/archive-listening-episode';
import { LISTENING_ERRORS, ListeningPublicationError } from '../../../src/services/listening/publication/listening-publication-types';

const MAX_BODY_BYTES = 512;

function checkAdminToken(req: any, res: any): boolean {
  const adminToken = process.env.LISTENING_ADMIN_TOKEN;
  if (!adminToken) {
    jsonError(res, 503, 'INTERNAL_ERROR', 'Operação administrativa não configurada.');
    return false;
  }
  const provided = req.headers['x-admin-token'];
  if (!provided || provided !== adminToken) {
    jsonError(res, 403, 'UNAUTHORIZED', 'Token administrativo inválido.');
    return false;
  }
  return true;
}

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, MAX_BODY_BYTES)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  if (!checkAdminToken(req, res)) return;

  const { episodeId } = req.body ?? {};

  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(String(episodeId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  }

  try {
    await archiveListeningEpisode(episodeId, userId);
    safeLog('admin/listening/archive', 'archived', 200, { episodeId });
    return res.status(200).json({ episodeId, archived: true });
  } catch (err) {
    if (err instanceof ListeningPublicationError) {
      const status = err.code === LISTENING_ERRORS.EPISODE_NOT_FOUND ? 404 : 422;
      return jsonError(res, status, err.code, err.message);
    }
    safeLog('admin/listening/archive', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao arquivar episódio.');
  }
}
