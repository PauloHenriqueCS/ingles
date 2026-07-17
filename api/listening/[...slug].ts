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
import { getListeningToday } from '../../src/services/listening/daily/get-listening-today';
import { getListeningByDate } from '../../src/services/listening/daily/get-listening-by-date';
import { resolveListeningActivityDate } from '../../src/services/listening/daily/resolve-listening-activity-date';
import { enqueueListeningJob } from '../../src/services/listening/jobs/enqueue-listening-job';
import { startListeningGeneration } from '../../src/services/listening/on-demand/start-listening-generation';
import { getListeningGenerationStatus } from '../../src/services/listening/on-demand/get-listening-generation-status';
import { processListeningGenerationStep } from '../../src/services/listening/on-demand/process-listening-generation-step';
import { retryListeningGeneration } from '../../src/services/listening/on-demand/retry-listening-generation';
import {
  OnDemandSessionNotFoundError,
  OnDemandSessionLockedError,
  OnDemandSessionTerminalError,
} from '../../src/services/listening/on-demand/listening-on-demand-types';
import {
  generateStorySession,
  decodeAnswerToken,
} from '../../src/services/listening/story-session/generate-story-session';
import { generateListeningStory as generateListeningStoryService, StoryTtsError } from '../../src/services/listening/story-session/generate-listening-story';

const ALLOWED_STORY_THEMES = new Set([
  'travel', 'work_career', 'daily_life', 'movies_series', 'music',
  'football_sports', 'technology', 'food_restaurants', 'relationships_social_life',
  'health_wellbeing', 'money_shopping', 'mystery_adventure',
]);

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

    let completionSaved: boolean | undefined;
    if (result.episodeCompleted) {
      completionSaved = false;
      try {
        const { data: sess } = await serviceClient
          .from('user_listening_block_sessions')
          .select('episode_id')
          .eq('id', sessionId)
          .maybeSingle();
        if (sess?.episode_id) {
          const activityDate = resolveListeningActivityDate();
          const { data: assignment } = await serviceClient
            .from('user_listening_assignments')
            .select('id')
            .eq('user_id', userId)
            .eq('episode_id', sess.episode_id)
            .eq('activity_date', activityDate)
            .maybeSingle();
          if (assignment?.id) {
            await serviceClient
              .from('user_listening_assignments')
              .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('id', assignment.id);
            await enqueueListeningJob(serviceClient, {
              jobType: 'CALCULATE_LISTENING_PERFORMANCE',
              idempotencyKey: `CALCULATE_LISTENING_PERFORMANCE:${assignment.id}`,
              payload: { jobType: 'CALCULATE_LISTENING_PERFORMANCE', userId, assignmentId: assignment.id, episodeId: sess.episode_id },
              episodeId: sess.episode_id,
            });
            completionSaved = true;
          }
        }
      } catch (err) {
        safeLog('listening/session/answer', 'completion_save_error', 500, { sessionId });
      }
    }

    return res.status(200).json({ ...result, completionSaved });
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

// ─── GET /api/listening/today ─────────────────────────────────────────────────

async function handleToday(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  try {
    const result = await getListeningToday(supabase, userId);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/today', 'today_delivered', 200, { status: result.status });
    return res.status(200).json(result);
  } catch (err) {
    safeLog('listening/today', 'internal_error', 500, {});
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao carregar listening do dia.');
  }
}

// ─── GET /api/listening/by-date ───────────────────────────────────────────────

async function handleByDate(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  const date = String(req.query?.date ?? '').trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError(res, 400, 'INVALID_REQUEST', 'date inválido (YYYY-MM-DD).');
  try {
    const result = await getListeningByDate(supabase, userId, date);
    res.setHeader('Cache-Control', 'private, max-age=300');
    safeLog('listening/by-date', 'by_date_delivered', 200, { date, status: result.status });
    return res.status(200).json(result);
  } catch {
    safeLog('listening/by-date', 'internal_error', 500, { date });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao buscar listening por data.');
  }
}

// ─── GET /api/listening/assignment-result ────────────────────────────────────

async function handleAssignmentResult(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;
  const assignmentId = String(req.query?.assignmentId ?? '').trim();
  if (!assignmentId || !/^[0-9a-f-]{36}$/i.test(assignmentId)) return jsonError(res, 400, 'INVALID_REQUEST', 'assignmentId inválido.');
  const { data, error } = await supabase
    .from('user_listening_results')
    .select('*')
    .eq('user_id', userId)
    .eq('assignment_id', assignmentId)
    .maybeSingle();
  if (error) return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao buscar resultado.');
  if (!data) return jsonError(res, 404, 'NOT_FOUND', 'Resultado não encontrado.');
  return res.status(200).json({
    assignmentId:        data.assignment_id,
    episodeId:           data.episode_id,
    activityDate:        data.activity_date,
    performanceScore:    data.performance_score,
    q1AttemptCycle:      data.q1_attempt_cycle,
    q2AttemptCycle:      data.q2_attempt_cycle,
    q1Weight:            data.q1_weight,
    q2Weight:            data.q2_weight,
    calculationVersion:  data.calculation_version,
    calculatedAt:        data.calculated_at,
  });
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

// ─── POST /api/listening/story/complete ──────────────────────────────────────

async function handleStoryComplete(req: any, res: any) {
  console.log('[5] Entrou na API → story/complete');
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 64)) return;
  const auth = await requireAuth(req, res);
  if (!auth) {
    console.error('[6] Autenticação falhou — requireAuth retornou null');
    return;
  }
  const { userId } = auth;
  console.log('[6] Usuário autenticado', { userId });
  console.log('[7] Payload recebido', { body: req.body });
  try {
    const serviceClient = getListeningServiceClient();
    const activityDate = resolveListeningActivityDate();
    const now = new Date().toISOString();
    console.log('[8] Executando select em user_listening_assignments', { userId, activityDate });

    const { data: existing, error: selectError } = await serviceClient
      .from('user_listening_assignments')
      .select('id, status')
      .eq('user_id', userId)
      .eq('activity_date', activityDate)
      .maybeSingle();

    console.log('[9] Resultado do select', { existing, selectError });

    if (existing) {
      if (existing.status === 'completed') {
        console.log('[8] Já estava completed — retornando sem alterar');
        safeLog('listening/story/complete', 'already_completed', 200, { userId, activityDate });
        console.log('[11] Retorno enviado ao frontend → 200 already_completed');
        return res.status(200).json({ activityDate, saved: true });
      }
      console.log('[8] Executando UPDATE em user_listening_assignments', { id: existing.id });
      const { error } = await serviceClient
        .from('user_listening_assignments')
        .update({ status: 'completed', completed_at: now, updated_at: now })
        .eq('id', existing.id);
      console.log('[9] Resultado do UPDATE', { error });
      if (error) throw error;
    } else {
      console.log('[8] Executando INSERT em user_listening_assignments', {
        user_id: userId,
        episode_id: null,
        activity_date: activityDate,
        status: 'completed',
      });
      const { error } = await serviceClient
        .from('user_listening_assignments')
        .insert({
          user_id: userId,
          episode_id: null,
          activity_date: activityDate,
          status: 'completed',
          assigned_at: now,
          completed_at: now,
          created_at: now,
          updated_at: now,
        });
      console.log('[9] Resultado do INSERT', { error });
      if (error) throw error;
    }

    safeLog('listening/story/complete', 'completion_saved', 200, { userId, activityDate });
    console.log('[11] Retorno enviado ao frontend → 200 saved');
    return res.status(200).json({ activityDate, saved: true });
  } catch (err) {
    console.error('[10] Erro completo', err);
    safeLog('listening/story/complete', 'internal_error', 500, { error: String(err) });
    console.log('[11] Retorno enviado ao frontend → 500 INTERNAL_ERROR');
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível registrar a conclusão.');
  }
}

// ─── POST /api/listening/story/generate ──────────────────────────────────────

async function handleStoryGenerate(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 64)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const openaiKey = process.env.OPENAI_API_KEY ?? '';
  const azureKey = process.env.AZURE_SPEECH_KEY ?? '';
  const azureRegion = process.env.AZURE_SPEECH_REGION ?? '';
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!openaiKey || !azureKey || !azureRegion || !secret) {
    safeLog('listening/story/generate', 'misconfigured', 503, {});
    return jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Serviço temporariamente indisponível.');
  }

  try {
    const serviceClient = getListeningServiceClient();
    const result = await generateStorySession(userId, serviceClient, openaiKey, azureKey, azureRegion, secret);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/story/generate', 'generated', 200, { level: result.level });
    return res.status(200).json(result);
  } catch (err) {
    const step = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    safeLog('listening/story/generate', 'failed', 500, { step });
    return jsonError(res, 500, 'GENERATION_FAILED', 'Não foi possível criar a história. Tente novamente.');
  }
}

// ─── POST /api/listening/story/verify ────────────────────────────────────────

async function handleStoryVerify(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 2048)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { answerToken, selectedOption } = req.body ?? {};
  if (!answerToken || typeof answerToken !== 'string')
    return jsonError(res, 400, 'INVALID_REQUEST', 'answerToken é obrigatório.');
  if (typeof selectedOption !== 'number' || selectedOption < 0 || selectedOption > 4)
    return jsonError(res, 400, 'INVALID_REQUEST', 'selectedOption inválido (0–4).');

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!secret) return jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Serviço indisponível.');

  try {
    const { correctIndex, explanationPt } = decodeAnswerToken(answerToken, secret);
    const correct = correctIndex === selectedOption;
    return res.status(200).json({ correct, correctOption: correctIndex, explanationPt });
  } catch {
    return jsonError(res, 400, 'INVALID_TOKEN', 'Token inválido ou expirado.');
  }
}

// ─── POST /api/listening/generate ────────────────────────────────────────────

async function handleListeningGenerate(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  // Up to 64 KB body — needed to accept storyPackage on TTS retry
  if (!sizeGuard(req, res, 65_536)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const openaiKey = process.env.OPENAI_API_KEY ?? '';
  const azureKey = process.env.AZURE_SPEECH_KEY ?? '';
  const azureRegion = process.env.AZURE_SPEECH_REGION ?? '';
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  const requestId = crypto.randomUUID().slice(0, 8);

  // Log env-var presence without exposing values
  safeLog('listening/generate', 'config_check', 0, {
    requestId,
    hasOpenaiKey: !!openaiKey,
    hasAzureKey: !!azureKey,
    azureRegion: (azureRegion || 'NOT_SET') as string,
    hasSecret: !!secret,
  });

  if (!openaiKey || !azureKey || !azureRegion || !secret) {
    safeLog('listening/generate', 'misconfigured', 503, { requestId });
    return jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Serviço temporariamente indisponível.');
  }

  // Optional: storyPackage from a previous call (skips OpenAI, retries TTS only)
  const storyPackage: string | undefined =
    typeof req.body?.storyPackage === 'string' ? req.body.storyPackage : undefined;

  // Optional: story theme — validated against allowed list; unknown values fall through to random
  const rawTheme = typeof req.body?.theme === 'string' ? req.body.theme.trim() : null;
  const theme = rawTheme && ALLOWED_STORY_THEMES.has(rawTheme) ? rawTheme : null;

  try {
    const serviceClient = getListeningServiceClient();
    const result = await generateListeningStoryService(
      userId, serviceClient, openaiKey, azureKey, azureRegion, secret,
      storyPackage ?? null, theme,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/generate', 'generated', 200, { requestId, level: result.level });
    return res.status(200).json(result);
  } catch (err) {
    // Infer stage from error shape/message
    let stage = 'calling_openai';
    if (err instanceof StoryTtsError) {
      stage = err.step.startsWith('STORAGE_') ? 'saving_audio' : 'calling_azure';
    } else if (err instanceof Error) {
      const m = err.message;
      if (m.startsWith('AI_INVALID_JSON') || m.startsWith('STORY_PACKAGE')) stage = 'parsing_story';
    }

    // OpenAI SDK errors expose status / code / type / request_id / cause
    const isOpenAIError = err instanceof Error && 'status' in err && 'type' in err;
    const upstreamStatus  = isOpenAIError ? (err as any).status      : null;
    const upstreamCode    = isOpenAIError ? (err as any).code        : null;
    const upstreamType    = isOpenAIError ? (err as any).type        : null;
    const upstreamReqId   = isOpenAIError ? (err as any).request_id  : null;
    const upstreamCause   = isOpenAIError && (err as any).cause instanceof Error
                              ? (err as any).cause.message : null;

    const errorName    = err instanceof Error ? err.name    : typeof err;
    const errorMessage = err instanceof Error ? err.message : String(err);

    safeLog('listening/generate', 'failed', 500, {
      requestId, stage, errorName,
      errorMessage: errorMessage.slice(0, 200),
      upstreamStatus, upstreamCode, upstreamType,
    });

    if (err instanceof StoryTtsError) {
      return jsonError(
        res, 500, 'TTS_FAILED',
        'Não conseguimos gerar o áudio. A história está preservada — tente novamente.',
        { storyPackage: err.storyPackage, step: err.step },
      );
    }

    // Temporary debug: expose full error details in Network response
    return res.status(500).json({
      code: 'GENERATION_FAILED',
      stage,
      errorName,
      errorMessage,
      upstreamStatus,
      upstreamCode,
      upstreamType,
      upstreamRequestId: upstreamReqId,
      upstreamCause,
      requestId,
    });
  }
}

// ─── POST /api/listening/on-demand/start ─────────────────────────────────────

async function handleOnDemandStart(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 64)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  try {
    const serviceClient = getListeningServiceClient();
    const localDate = resolveListeningActivityDate();
    const result = await startListeningGeneration(userId, serviceClient, localDate);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/on-demand/start', 'generation_started', 200, { userId, status: result.status });
    return res.status(200).json(result);
  } catch (err) {
    safeLog('listening/on-demand/start', 'internal_error', 500, { error: String(err) });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao iniciar geração.');
  }
}

// ─── GET /api/listening/on-demand/status?sessionId=UUID ──────────────────────

async function handleOnDemandStatus(req: any, res: any) {
  if (!methodGuard(req, res, ['GET'])) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const sessionId = String(req.query?.sessionId ?? '').trim();
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  }
  try {
    const serviceClient = getListeningServiceClient();
    const result = await getListeningGenerationStatus(sessionId, userId, serviceClient);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof OnDemandSessionNotFoundError) {
      return jsonError(res, 404, 'ON_DEMAND_SESSION_NOT_FOUND', 'Sessão não encontrada.');
    }
    safeLog('listening/on-demand/status', 'internal_error', 500, {});
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao buscar status.');
  }
}

// ─── POST /api/listening/on-demand/process-next ───────────────────────────────

async function handleOnDemandProcessNext(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 256)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  }
  try {
    const serviceClient = getListeningServiceClient();
    const result = await processListeningGenerationStep(String(sessionId), userId, serviceClient);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/on-demand/process-next', 'step_processed', 200, { status: result.status });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof OnDemandSessionNotFoundError) {
      return jsonError(res, 404, 'ON_DEMAND_SESSION_NOT_FOUND', 'Sessão não encontrada.');
    }
    if (err instanceof OnDemandSessionLockedError) {
      // Return current status instead of error — safe for concurrent calls
      try {
        const serviceClient = getListeningServiceClient();
        const status = await getListeningGenerationStatus(String(sessionId), userId, serviceClient);
        return res.status(200).json(status);
      } catch {
        return jsonError(res, 409, 'ON_DEMAND_SESSION_LOCKED', 'Sessão ocupada. Tente novamente.');
      }
    }
    if (err instanceof OnDemandSessionTerminalError) {
      try {
        const serviceClient = getListeningServiceClient();
        const status = await getListeningGenerationStatus(String(sessionId), userId, serviceClient);
        return res.status(200).json(status);
      } catch {
        return jsonError(res, 409, 'ON_DEMAND_SESSION_TERMINAL', 'Sessão já finalizada.');
      }
    }
    safeLog('listening/on-demand/process-next', 'internal_error', 500, { error: String(err) });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao processar etapa.');
  }
}

// ─── POST /api/listening/on-demand/retry ──────────────────────────────────────

async function handleOnDemandRetry(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, 256)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const { sessionId } = req.body ?? {};
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'sessionId inválido.');
  }
  try {
    const serviceClient = getListeningServiceClient();
    const result = await retryListeningGeneration(String(sessionId), userId, serviceClient);
    res.setHeader('Cache-Control', 'private, no-store');
    safeLog('listening/on-demand/retry', 'retry_requested', 200, { status: result.status });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof OnDemandSessionNotFoundError) {
      return jsonError(res, 404, 'ON_DEMAND_SESSION_NOT_FOUND', 'Sessão não encontrada.');
    }
    safeLog('listening/on-demand/retry', 'internal_error', 500, {});
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro ao tentar novamente.');
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
    case 'today':                      return handleToday(req, res);
    case 'by-date':                    return handleByDate(req, res);
    case 'assignment-result':          return handleAssignmentResult(req, res);
    case 'generate':                   return handleListeningGenerate(req, res);
    case 'story/complete':             return handleStoryComplete(req, res);
    case 'story/generate':             return handleStoryGenerate(req, res);
    case 'story/verify':               return handleStoryVerify(req, res);
    case 'on-demand/start':            return handleOnDemandStart(req, res);
    case 'on-demand/status':           return handleOnDemandStatus(req, res);
    case 'on-demand/process-next':     return handleOnDemandProcessNext(req, res);
    case 'on-demand/retry':            return handleOnDemandRetry(req, res);
    default:                           return res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  }
}
