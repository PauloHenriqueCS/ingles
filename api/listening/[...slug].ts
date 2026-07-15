import { requireAuth } from '../_auth';
import { methodGuard, sizeGuard, jsonError, safeLog, resolveSlug } from '../_helpers';
import { canUserAccessListeningEpisode } from '../../src/services/listening/publication/authorize-listening-access';
import { buildPublicListeningEpisode } from '../../src/services/listening/publication/build-public-listening-episode';
import { LISTENING_ERRORS, ListeningPublicationError } from '../../src/services/listening/publication/listening-publication-types';
import { buildListeningEpisodeSession } from '../../src/services/listening/execution/build-listening-episode-session';
import { ListeningExecutionError, LISTENING_EXECUTION_ERRORS } from '../../src/services/listening/execution/listening-execution-types';
import { createListeningAudioSignedUrl } from '../../src/services/listening/publication/create-listening-signed-url';
import { getListeningServiceClient } from '../../src/services/listening/publication/_supabase';
import { abandonListeningSession } from '../../src/services/listening/execution/abandon-listening-session';
import { submitListeningAnswer } from '../../src/services/listening/execution/submit-listening-answer';
import { markListeningPlaybackCompleted } from '../../src/services/listening/execution/mark-listening-playback-completed';

// ─── GET /api/listening/episode?episodeId=UUID ────────────────────────────────

async function handleEpisode(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  const episodeId = String(req.query?.episodeId ?? '').trim();
  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(episodeId)) return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  const access = await canUserAccessListeningEpisode(supabase, { userId, episodeId });
  if (!access.allowed) {
    safeLog('listening/episode', 'access_denied', 403, { episodeId, reason: access.reason ?? 'denied' });
    if (access.reason === 'episode_archived') return jsonError(res, 404, LISTENING_ERRORS.EPISODE_ARCHIVED, 'Episódio não disponível.');
    if (access.reason === 'episode_not_found') return jsonError(res, 404, LISTENING_ERRORS.EPISODE_NOT_FOUND, 'Episódio não encontrado.');
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
      if (err.code === LISTENING_ERRORS.EPISODE_NOT_FOUND) return jsonError(res, 404, err.code, 'Episódio não encontrado.');
      if (err.code === LISTENING_ERRORS.ACCESS_DENIED || err.code === LISTENING_ERRORS.EPISODE_ARCHIVED) return jsonError(res, 403, err.code, 'Acesso negado.');
      safeLog('listening/episode', 'publication_error', 500, { episodeId, code: err.code });
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao carregar episódio.');
    }
    safeLog('listening/episode', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── GET /api/listening/episodes ─────────────────────────────────────────────

async function handleEpisodes(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { supabase } = auth;
  try {
    const { data: episodes, error } = await supabase
      .from('listening_episodes')
      .select('id, title, synopsis, cefr_level, estimated_duration_seconds')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) { safeLog('listening/episodes', 'db_error', 500, { error: error.message }); return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao buscar episódios.'); }
    const result = (episodes ?? []).map((ep: any) => ({
      id: ep.id, title: ep.title, synopsis: ep.synopsis ?? null, cefrLevel: ep.cefr_level, estimatedDurationSeconds: ep.estimated_duration_seconds,
    }));
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(result);
  } catch {
    safeLog('listening/episodes', 'internal_error', 500, {});
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── GET /api/listening/episode-session?episodeId=UUID ───────────────────────

async function handleEpisodeSession(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  const episodeId = String(req.query?.episodeId ?? '').trim();
  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(episodeId)) return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  const access = await canUserAccessListeningEpisode(supabase, { userId, episodeId });
  if (!access.allowed) {
    safeLog('listening/episode-session', 'access_denied', 403, { episodeId });
    if (access.reason === 'episode_not_found') return jsonError(res, 404, LISTENING_ERRORS.EPISODE_NOT_FOUND, 'Episódio não encontrado.');
    return jsonError(res, 403, LISTENING_ERRORS.ACCESS_DENIED, 'Acesso negado.');
  }
  try {
    const data = await buildListeningEpisodeSession(episodeId, userId, supabase);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/episode-session', 'session_delivered', 200, { episodeId });
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.EPISODE_NOT_FOUND) return jsonError(res, 404, err.code, 'Episódio não encontrado.');
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_CONFLICT && err.retryable) return jsonError(res, 409, err.code, 'Conflito ao criar sessão — tente novamente.');
      safeLog('listening/episode-session', 'execution_error', 500, { episodeId, code: err.code });
      return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao carregar sessão do episódio.');
    }
    safeLog('listening/episode-session', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── POST /api/listening/audio-refresh ───────────────────────────────────────

async function handleAudioRefresh(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 512)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  const { episodeId, blockId } = req.body ?? {};
  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(String(episodeId))) return jsonError(res, 400, 'INVALID_REQUEST', 'episodeId inválido.');
  if (!blockId || !/^[0-9a-f-]{36}$/i.test(String(blockId))) return jsonError(res, 400, 'INVALID_REQUEST', 'blockId inválido.');
  const access = await canUserAccessListeningEpisode(supabase, { userId, episodeId });
  if (!access.allowed) { safeLog('listening/audio-refresh', 'access_denied', 403, { episodeId }); return jsonError(res, 403, LISTENING_ERRORS.ACCESS_DENIED, 'Acesso negado.'); }
  try {
    const signed = await createListeningAudioSignedUrl({ userId, episodeId, blockId }, supabase);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/audio-refresh', 'url_refreshed', 200, { episodeId });
    return res.status(200).json({ blockId: signed.blockId, blockOrder: signed.blockOrder, url: signed.url, expiresAt: signed.expiresAt, durationMs: signed.durationMs, contentType: signed.contentType });
  } catch (err) {
    if (err instanceof ListeningPublicationError) { safeLog('listening/audio-refresh', 'signed_url_failed', 500, { episodeId, code: err.code }); return jsonError(res, 500, err.code, 'Não foi possível renovar a URL do áudio.'); }
    safeLog('listening/audio-refresh', 'internal_error', 500, { episodeId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── POST /api/listening/session/abandon ─────────────────────────────────────

async function handleSessionAbandon(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 256)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  try {
    const serviceClient = getListeningServiceClient();
    await abandonListeningSession(serviceClient, sessionId, userId);
    safeLog('listening/session/abandon', 'session_abandoned', 200, { sessionId });
    return res.status(200).json({ sessionId, status: 'abandoned' });
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND) return jsonError(res, 404, err.code, 'Sessão não encontrada.');
      safeLog('listening/session/abandon', 'execution_error', 500, { sessionId, code: err.code });
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── POST /api/listening/session/answer ──────────────────────────────────────

async function handleSessionAnswer(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 512)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const { sessionId, questionId, selectedOption, submissionId, playbackRate } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  if (!questionId || !/^[0-9a-f-]{36}$/i.test(String(questionId))) return jsonError(res, 400, 'INVALID_REQUEST', 'questionId inválido.');
  if (typeof selectedOption !== 'number' || !Number.isInteger(selectedOption) || selectedOption < 0) return jsonError(res, 400, 'INVALID_REQUEST', 'selectedOption inválido.');
  if (!submissionId || !/^[0-9a-f-]{36}$/i.test(String(submissionId))) return jsonError(res, 400, 'INVALID_REQUEST', 'submissionId inválido (deve ser UUID).');
  try {
    const serviceClient = getListeningServiceClient();
    const result = await submitListeningAnswer(serviceClient, { sessionId, userId, questionId, selectedOption, submissionId, playbackRate: typeof playbackRate === 'number' ? playbackRate : 1.0 });
    safeLog('listening/session/answer', 'answer_processed', 200, { sessionId, correct: result.correct, attemptNumber: result.attemptNumber });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND) return jsonError(res, 404, err.code, 'Sessão não encontrada.');
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED) return jsonError(res, 410, err.code, 'Sessão expirada.');
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE) return jsonError(res, 409, err.code, 'Estado da sessão inválido.');
      if (err.code === LISTENING_EXECUTION_ERRORS.QUESTION_NOT_FOUND) return jsonError(res, 404, err.code, 'Pergunta não encontrada.');
      if (err.code === LISTENING_EXECUTION_ERRORS.DUPLICATE_SUBMISSION) return jsonError(res, 409, err.code, 'Submissão duplicada.');
      safeLog('listening/session/answer', 'execution_error', 500, { sessionId, code: err.code });
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── POST /api/listening/session/audio-refresh ───────────────────────────────

async function handleSessionAudioRefresh(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 256)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  try {
    const serviceClient = getListeningServiceClient();
    const { data: session, error: sessionError } = await serviceClient
      .from('user_listening_block_sessions')
      .select('id, user_id, episode_id, block_id, status, expires_at')
      .eq('id', sessionId).eq('user_id', userId).maybeSingle();
    if (sessionError || !session) return jsonError(res, 404, LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND, 'Sessão não encontrada.');
    if (new Date(session.expires_at) <= new Date()) return jsonError(res, 410, LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED, 'Sessão expirada.');
    if (session.status === 'completed' || session.status === 'abandoned') return jsonError(res, 409, LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE, 'Sessão encerrada.');
    const signed = await createListeningAudioSignedUrl({ userId, episodeId: session.episode_id, blockId: session.block_id }, supabase);
    safeLog('listening/session/audio-refresh', 'url_refreshed', 200, { sessionId });
    return res.status(200).json({ sessionId, url: signed.url, expiresAt: signed.expiresAt, durationMs: signed.durationMs });
  } catch (err) {
    if (err instanceof ListeningPublicationError) { safeLog('listening/session/audio-refresh', 'signed_url_failed', 500, { sessionId, code: err.code }); return jsonError(res, 500, err.code, 'Não foi possível renovar a URL do áudio.'); }
    if (err instanceof ListeningExecutionError) return jsonError(res, 500, err.code, 'Erro ao renovar URL de áudio.');
    safeLog('listening/session/audio-refresh', 'internal_error', 500, { sessionId });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── POST /api/listening/session/playback-completed ──────────────────────────

async function handleSessionPlaybackCompleted(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 256)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  try {
    const serviceClient = getListeningServiceClient();
    const session = await markListeningPlaybackCompleted(serviceClient, sessionId, userId);
    safeLog('listening/session/playback-completed', 'playback_marked', 200, { sessionId });
    return res.status(200).json({ sessionId: session.id, status: session.status, currentAttempt: session.currentAttempt, expiresAt: session.expiresAt });
  } catch (err) {
    if (err instanceof ListeningExecutionError) {
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_NOT_FOUND) return jsonError(res, 404, err.code, 'Sessão não encontrada.');
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_EXPIRED) return jsonError(res, 410, err.code, 'Sessão expirada.');
      if (err.code === LISTENING_EXECUTION_ERRORS.SESSION_WRONG_STATE) return jsonError(res, 409, err.code, 'Estado da sessão inválido para esta operação.');
      safeLog('listening/session/playback-completed', 'execution_error', 500, { sessionId, code: err.code });
    }
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  const slug = resolveSlug(req, '/api/listening');
  switch (slug) {
    case 'episode':                    return handleEpisode(req, res);
    case 'episodes':                   return handleEpisodes(req, res);
    case 'episode-session':            return handleEpisodeSession(req, res);
    case 'audio-refresh':              return handleAudioRefresh(req, res);
    case 'session/abandon':            return handleSessionAbandon(req, res);
    case 'session/answer':             return handleSessionAnswer(req, res);
    case 'session/audio-refresh':      return handleSessionAudioRefresh(req, res);
    case 'session/playback-completed': return handleSessionPlaybackCompleted(req, res);
    default:                           return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
