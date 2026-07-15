/**
 * POST /api/listening/audio-refresh
 * Body: { episodeId: string, blockId: string }
 * Renova a URL assinada do áudio de um bloco.
 * O backend resolve o path correto — nunca confia no path enviado pelo cliente.
 */

import { requireAuth } from '../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog } from '../_helpers';
import { canUserAccessListeningEpisode } from '../../src/services/listening/publication/authorize-listening-access';
import { createListeningAudioSignedUrl } from '../../src/services/listening/publication/create-listening-signed-url';
import { LISTENING_ERRORS, ListeningPublicationError } from '../../src/services/listening/publication/listening-publication-types';

const MAX_BODY_BYTES = 512;

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, MAX_BODY_BYTES)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const { episodeId, blockId } = req.body ?? {};

  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(String(episodeId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  }
  if (!blockId || !/^[0-9a-f-]{36}$/i.test(String(blockId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'blockId inválido.');
  }

  const access = await canUserAccessListeningEpisode(supabase, { userId, episodeId });
  if (!access.allowed) {
    safeLog('listening/audio-refresh', 'access_denied', 403, { episodeId });
    return jsonError(res, 403, LISTENING_ERRORS.ACCESS_DENIED, 'Acesso negado.');
  }

  try {
    const signed = await createListeningAudioSignedUrl(
      { userId, episodeId, blockId },
      supabase,
    );

    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/audio-refresh', 'url_refreshed', 200, { episodeId });
    return res.status(200).json({
      blockId: signed.blockId,
      blockOrder: signed.blockOrder,
      url: signed.url,
      expiresAt: signed.expiresAt,
      durationMs: signed.durationMs,
      contentType: signed.contentType,
    });
  } catch (err) {
    if (err instanceof ListeningPublicationError) {
      safeLog('listening/audio-refresh', 'signed_url_failed', 500, { episodeId, code: err.code });
      return jsonError(res, 500, err.code, 'Não foi possível renovar a URL do áudio.');
    }
    safeLog('listening/audio-refresh', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
