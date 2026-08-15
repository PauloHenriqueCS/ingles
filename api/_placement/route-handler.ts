/**
 * SERVER-ONLY HTTP handlers for the placement (level classification) endpoints,
 * folded into the grammar-explanation function via __lemonRoute (Vercel
 * 12-function cap). Routes (rewritten from /api/placement/* in vercel.json):
 *   GET  /api/placement/state        → current onboarding screen + status
 *   POST /api/placement/start        → begin (or resume) the adaptive test
 *   POST /api/placement/answer       → submit one objective answer (server-checked)
 *   POST /api/placement/skip         → skip; keeps the user at the course default
 *   POST /api/placement/c2-submit    → submit one C2 open response (evaluates on 2nd)
 *   POST /api/placement/c2-evaluate  → retry a pending C2 evaluation
 *
 * The answer key is NEVER sent to the client — correctness is decided here with
 * the service-role client (placement_question_keys is private, RLS-denied to
 * authenticated). The official course level is only ever RAISED (monotonic).
 */

import { requireAuth } from '../_auth';
import { methodGuard, readRawBody, jsonError, safeLog, PAYLOAD_LIMITS } from '../_helpers';
import { applyRateLimit } from '../_rateLimit';
import { getPlacementServiceClient } from './service-client';
import { makeC2Evaluator } from './c2-evaluation';
import {
  getPlacementState,
  startPlacement,
  submitAnswer,
  skipPlacement,
  submitC2Response,
  evaluatePendingC2,
  PlacementConfigError,
} from './placement-runtime';

const OPTION_KEY_RE = /^[A-Z]$/;
const QUESTION_KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;
const STEP_KEY_RE = /^[a-z_]{1,32}$/;
const C2_TEXT_MAX = 2000;

async function parseBody(req: any): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, PAYLOAD_LIMITS.CONVERSATION);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
}

export async function handlePlacementRoute(req: any, res: any, action: string): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;
  const service = getPlacementServiceClient();

  try {
    if (action === 'state') {
      if (!methodGuard(req, res, ['GET'])) return;
      const state = await getPlacementState(service, userId);
      return void res.status(200).json(state);
    }

    if (action === 'start') {
      if (!methodGuard(req, res, ['POST'])) return;
      const state = await startPlacement(service, userId);
      return void res.status(200).json(state);
    }

    if (action === 'skip') {
      if (!methodGuard(req, res, ['POST'])) return;
      const state = await skipPlacement(service, userId);
      return void res.status(200).json(state);
    }

    if (action === 'answer') {
      if (!methodGuard(req, res, ['POST'])) return;
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { return jsonError(res, 400, 'INVALID_REQUEST', 'Corpo inválido.'); }
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
      const questionKey = typeof body.questionKey === 'string' ? body.questionKey : '';
      const optionKey = typeof body.optionKey === 'string' ? body.optionKey : '';
      if (!attemptId || !QUESTION_KEY_RE.test(questionKey) || !OPTION_KEY_RE.test(optionKey)) {
        return jsonError(res, 400, 'INVALID_REQUEST', 'Parâmetros inválidos.');
      }
      const state = await submitAnswer(service, userId, attemptId, questionKey, optionKey);
      return void res.status(200).json(state);
    }

    if (action === 'c2-submit') {
      if (!methodGuard(req, res, ['POST'])) return;
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { return jsonError(res, 400, 'INVALID_REQUEST', 'Corpo inválido.'); }
      const attemptId = typeof body.attemptId === 'string' ? body.attemptId : '';
      const stepKey = typeof body.stepKey === 'string' ? body.stepKey : '';
      const text = typeof body.text === 'string' ? body.text.slice(0, C2_TEXT_MAX) : '';
      if (!attemptId || !STEP_KEY_RE.test(stepKey)) {
        return jsonError(res, 400, 'INVALID_REQUEST', 'Parâmetros inválidos.');
      }
      // Submitting the 2nd step triggers a paid AI evaluation → fail-closed limit.
      if (!await applyRateLimit(res, userId, 'placement-c2')) return;
      const apiKey = process.env.OPENAI_API_KEY ?? '';
      const evaluator = makeC2Evaluator(service, apiKey);
      const state = await submitC2Response(service, userId, attemptId, stepKey, text, evaluator);
      return void res.status(200).json(state);
    }

    if (action === 'c2-evaluate') {
      if (!methodGuard(req, res, ['POST'])) return;
      if (!await applyRateLimit(res, userId, 'placement-c2')) return;
      const apiKey = process.env.OPENAI_API_KEY ?? '';
      const evaluator = makeC2Evaluator(service, apiKey);
      const state = await evaluatePendingC2(service, userId, evaluator);
      return void res.status(200).json(state);
    }

    return jsonError(res, 404, 'NOT_FOUND', 'Rota de placement desconhecida.');
  } catch (err) {
    if (err instanceof PlacementConfigError) {
      safeLog('placement', 'config_error', 503, { action });
      return jsonError(res, 503, 'PLACEMENT_NOT_CONFIGURED', 'Teste de nível indisponível no momento.');
    }
    safeLog('placement', 'error', 500, { action });
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Erro interno.');
  }
}
