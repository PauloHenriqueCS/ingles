/**
 * POST /api/admin/recalibrate-v2
 *
 * Recalibrates a specific user (or the single real user) for V2 engine.
 *
 * What it does:
 *   1. Checks idempotency — skips if already done for this user+version
 *   2. Reads current learner_skill_profiles (set by migration 20260714160003)
 *   3. Runs promotion evaluation for writing, pronunciation, conversation
 *   4. Records the calibration result in engine_activation_log
 *   5. Returns skill levels before/after with confidence
 *
 * What it does NOT do:
 *   - Does not downgrade user if V2 calculates lower level than legacy
 *   - Does not invent evidence
 *   - Skills with no data stay as 'unknown' / 'insufficient_data'
 *
 * Requires: x-admin-token header matching ADMIN_TOKEN env var.
 */

import { createClient } from '@supabase/supabase-js';
import { methodGuard, jsonError } from '../_helpers';
import { evaluateSkillPromotion } from '../../src/lib/promotionService';
import { getLearnerSkillProfiles } from '../../src/lib/learnerProfileRepository';
import { getActiveLearningEngineVersion } from '../../src/lib/engineVersion';
import type { LearningSkill } from '../../src/domain/learner/learner-skill-types';

const SKILLS: LearningSkill[] = ['writing', 'pronunciation', 'conversation'];
const RECALIBRATION_VERSION = 'v2';
const RECALIBRATION_ENGINE_VERSION = 'v2.0.0';

function createServiceSupabase() {
  return createClient(
    process.env.VITE_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  );
}

function checkAdminAuth(req: any, res: any): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];

  if (!adminToken) {
    jsonError(res, 503, 'INTERNAL_ERROR', 'ADMIN_TOKEN não configurado no servidor.');
    return false;
  }
  if (!provided || provided !== adminToken) {
    jsonError(res, 403, 'FORBIDDEN', 'Acesso administrativo negado.');
    return false;
  }
  return true;
}

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!checkAdminAuth(req, res)) return;

  const startedAt = Date.now();
  const supabase = createServiceSupabase();

  // ── Resolve userId ──────────────────────────────────────────────────────────

  const { userId } = (req.body ?? {}) as { userId?: string };
  if (!userId || typeof userId !== 'string') {
    jsonError(res, 400, 'INVALID_REQUEST', 'userId é obrigatório no body.');
    return;
  }

  const idempotencyKey = `v2-recalibration:${userId}:${RECALIBRATION_VERSION}`;
  const engineVersion = getActiveLearningEngineVersion();

  // ── Idempotency check ───────────────────────────────────────────────────────

  const { data: existingLog } = await supabase
    .from('engine_activation_log')
    .select('id, status, result_json, completed_at')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingLog?.status === 'completed') {
    return res.status(200).json({
      skipped: true,
      reason: 'already_calibrated',
      idempotencyKey,
      completedAt: existingLog.completed_at,
      result: existingLog.result_json,
    });
  }

  // ── Insert pending log (advisory lock via unique constraint) ────────────────

  const { error: insertErr } = await supabase
    .from('engine_activation_log')
    .insert({
      user_id: userId,
      executed_by: 'admin_api',
      operation: 'v2_recalibration',
      engine_version: RECALIBRATION_ENGINE_VERSION,
      idempotency_key: idempotencyKey,
      status: 'pending',
    });

  if (insertErr) {
    // If unique conflict → another process is running; return 409
    if (insertErr.code === '23505') {
      jsonError(res, 409, 'CONFLICT', 'Recalibração já em andamento para este usuário.');
      return;
    }
    jsonError(res, 500, 'INTERNAL_ERROR', `Falha ao registrar recalibração: ${insertErr.message}`);
    return;
  }

  // ── Read current skill profiles (before recalibration) ─────────────────────

  let profilesBefore: Awaited<ReturnType<typeof getLearnerSkillProfiles>>;
  try {
    profilesBefore = await getLearnerSkillProfiles(supabase, userId);
  } catch (err) {
    await markFailed(supabase, idempotencyKey, String(err));
    jsonError(res, 500, 'INTERNAL_ERROR', 'Falha ao ler perfis do usuário.');
    return;
  }

  // ── Run promotion evaluation for each skill ─────────────────────────────────
  //
  // Strategy:
  //   - Skills with data get evaluated normally
  //   - If V2 produces a lower level than the legacy level, we keep the legacy
  //     level as safe fallback and record the discrepancy
  //   - Skills with no data (level=null, status='unknown') stay as-is
  //     (they are NOT arbitrarily set to A1)

  const skillResults: Record<string, unknown> = {};

  for (const skill of SKILLS) {
    const before = profilesBefore.find(p => p.skill === skill);
    const legacyLevel = before?.level ?? null;

    // No evidence at all for this skill — preserve unknown state
    if (!before || (before.status === 'unknown' && !legacyLevel)) {
      skillResults[skill] = {
        status: 'insufficient_data',
        legacyLevel: null,
        calibratedLevel: null,
        decision: 'no_data',
        note: 'Nenhuma evidência disponível; perfil permanece unknown.',
      };
      continue;
    }

    // Run promotion evaluation
    const evalKey = `${idempotencyKey}:${skill}`;
    try {
      const evaluation = await evaluateSkillPromotion({
        userId,
        skill: skill as 'writing' | 'pronunciation' | 'conversation',
        trigger: 'admin_recalculate',
        idempotencyKey: evalKey,
      });

      const calibratedLevel = evaluation.currentLevel ?? legacyLevel;

      // Anti-downgrade: if V2 calculates lower than legacy, keep legacy
      // and flag for reassessment
      let appliedLevel = calibratedLevel;
      let downgradeBlocked = false;

      if (legacyLevel && calibratedLevel && calibratedLevel !== legacyLevel) {
        const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
        const legacyIdx = CEFR_ORDER.indexOf(legacyLevel);
        const calibratedIdx = CEFR_ORDER.indexOf(calibratedLevel);

        if (calibratedIdx < legacyIdx) {
          // V2 calculated a lower level — block downgrade
          appliedLevel = legacyLevel;
          downgradeBlocked = true;
        }
      }

      skillResults[skill] = {
        status: 'evaluated',
        legacyLevel,
        calibratedLevel: appliedLevel,
        v2RawLevel: calibratedLevel,
        downgradeBlocked,
        decision: evaluation.decision,
        confidence: evaluation.promotionConfidence,
        progressPercent: evaluation.progressPercent,
        blockingReasons: evaluation.blockingReasons ?? [],
        note: downgradeBlocked
          ? `Nível legado preservado (V2 calculou ${calibratedLevel}, legado era ${legacyLevel}). Status: reassessment_required.`
          : 'Recalibrado com sucesso.',
      };

    } catch (err) {
      console.error(JSON.stringify({ route: 'recalibrate-v2', event: 'skill_eval_failed', skill, userId, error: String(err) }));
      skillResults[skill] = {
        status: 'error',
        legacyLevel,
        calibratedLevel: legacyLevel,
        error: String(err),
        note: 'Avaliação falhou; nível legado preservado.',
      };
    }
  }

  // ── Mark log as completed ───────────────────────────────────────────────────

  const resultJson = {
    engineVersion: RECALIBRATION_ENGINE_VERSION,
    calibratedAt: new Date().toISOString(),
    skills: skillResults,
    activeEngineVersion: engineVersion,
  };

  await supabase
    .from('engine_activation_log')
    .update({
      status: 'completed',
      result_json: resultJson,
      duration_ms: Date.now() - startedAt,
      completed_at: new Date().toISOString(),
    })
    .eq('idempotency_key', idempotencyKey);

  console.error(JSON.stringify({ route: 'recalibrate-v2', event: 'completed', userId, durationMs: Date.now() - startedAt }));

  return res.status(200).json({
    skipped: false,
    userId,
    idempotencyKey,
    result: resultJson,
  });
}

async function markFailed(supabase: ReturnType<typeof createServiceSupabase>, key: string, error: string) {
  await supabase
    .from('engine_activation_log')
    .update({ status: 'failed', error_message: error, completed_at: new Date().toISOString() })
    .eq('idempotency_key', key);
}
