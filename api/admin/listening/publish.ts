/**
 * POST /api/admin/listening/publish
 * Body: { episodeId: string }
 * Rota administrativa protegida por autenticação + token de admin.
 * Publicação completa: valida → copia arquivos → atualiza banco → marca publicado.
 */

import { requireAuth } from '../../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog } from '../../_helpers';
import { publishListeningEpisode } from '../../../src/services/listening/publication/publish-listening-episode';
import { validateListeningEpisodeForPublication } from '../../../src/services/listening/publication/validate-listening-publication';
import { LISTENING_ERRORS, ListeningPublicationError } from '../../../src/services/listening/publication/listening-publication-types';

const MAX_BODY_BYTES = 512;

function checkAdminToken(req: any, res: any): boolean {
  const adminToken = process.env.LISTENING_ADMIN_TOKEN;
  if (!adminToken) {
    jsonError(res, 503, 'INTERNAL_ERROR', 'Publicação administrativa não configurada.');
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

  const { episodeId, validateOnly } = req.body ?? {};

  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(String(episodeId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  }

  safeLog('admin/listening/publish', 'publish_requested', 200, {
    episodeId,
    validate_only: !!validateOnly,
    published_by: userId,
  });

  try {
    if (validateOnly) {
      const validation = await validateListeningEpisodeForPublication(episodeId);
      return res.status(200).json({ validation });
    }

    const result = await publishListeningEpisode({
      episodeId,
      publishedBy: userId,
      publicationSource: 'admin',
    });

    safeLog('admin/listening/publish', 'publish_succeeded', 200, {
      episodeId,
      publication_version: result.publicationVersion,
    });

    return res.status(200).json({
      episodeId: result.episodeId,
      publicationStatus: result.publicationStatus,
      publishedAt: result.publishedAt,
      publicationVersion: result.publicationVersion,
      blocks: result.blocks.map((b) => ({
        blockId: b.blockId,
        blockOrder: b.blockOrder,
        finalAudioPath: b.finalAudioPath,
        durationMs: b.durationMs,
        audioHash: b.audioHash,
      })),
    });
  } catch (err) {
    if (err instanceof ListeningPublicationError) {
      safeLog('admin/listening/publish', 'publish_failed', 400, { episodeId, code: err.code });
      const status =
        err.code === LISTENING_ERRORS.EPISODE_NOT_FOUND ? 404 :
        err.code === LISTENING_ERRORS.EPISODE_ALREADY_PUBLISHED ? 409 :
        err.code === LISTENING_ERRORS.VALIDATION_FAILED ? 422 : 500;
      return jsonError(res, status, err.code, err.message);
    }
    safeLog('admin/listening/publish', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno ao publicar episódio.');
  }
}
