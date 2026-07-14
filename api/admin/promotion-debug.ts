import { createClient } from '@supabase/supabase-js';
import { methodGuard, jsonError } from '../_helpers';
import { evaluateSkillPromotion } from '../../src/lib/promotionService';
import { getEvaluationsForSkill } from '../../src/lib/promotionEvaluationRepository';
import { getLearnerSkillProfiles } from '../../src/lib/learnerProfileRepository';
import type { LearningSkill } from '../../src/domain/learner/learner-skill-types';
import type { PromotionTrigger } from '../../src/domain/promotion/promotion-types';

const VALID_SKILLS = ['writing', 'pronunciation', 'conversation'] as const;
type ValidSkill = typeof VALID_SKILLS[number];

function isValidSkill(s: unknown): s is ValidSkill {
  return typeof s === 'string' && (VALID_SKILLS as readonly string[]).includes(s);
}

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
    jsonError(res, 401, 'UNAUTHORIZED', 'Token de admin inválido ou ausente.');
    return false;
  }
  return true;
}

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  if (!checkAdminAuth(req, res)) return;

  const method = (req.method ?? 'GET').toUpperCase();

  // POST ?action=recalculate&userId=X&skill=Y
  if (method === 'POST') {
    const query = req.query ?? {};
    const { action, userId, skill } = query as Record<string, unknown>;

    if (action !== 'recalculate') {
      jsonError(res, 400, 'INVALID_REQUEST', 'action deve ser recalculate.');
      return;
    }
    if (typeof userId !== 'string' || !userId) {
      jsonError(res, 400, 'INVALID_REQUEST', 'userId é obrigatório.');
      return;
    }
    if (!isValidSkill(skill)) {
      jsonError(res, 400, 'INVALID_REQUEST', 'skill deve ser writing, pronunciation ou conversation.');
      return;
    }

    try {
      const trigger: PromotionTrigger = 'admin_recalculate';
      const idempotencyKey = `admin:${userId}:${skill}:${trigger}:${Date.now()}`;
      const evaluation = await evaluateSkillPromotion({
        userId,
        skill,
        trigger,
        idempotencyKey,
      });
      res.status(200).json({ evaluation });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao recalcular promoção.';
      jsonError(res, 500, 'INTERNAL_ERROR', message);
    }
    return;
  }

  // GET ?userId=X&skill=Y (optional skill)
  const query = req.query ?? {};
  const { userId, skill } = query as Record<string, unknown>;

  if (typeof userId !== 'string' || !userId) {
    jsonError(res, 400, 'INVALID_REQUEST', 'userId é obrigatório.');
    return;
  }

  const supabase = createServiceSupabase();

  try {
    // 1. Get current skill profiles for all skills
    const profiles = await getLearnerSkillProfiles(supabase, userId);

    // 2. Get last 5 evaluations per skill (or for the specified skill)
    const skillsToCheck: LearningSkill[] = isValidSkill(skill)
      ? [skill as LearningSkill]
      : ['writing', 'pronunciation', 'conversation'];

    const evaluationsBySkill: Record<string, unknown[]> = {};
    for (const s of skillsToCheck) {
      const evals = await getEvaluationsForSkill(supabase, userId, s, 5);
      evaluationsBySkill[s] = evals.map(e => ({
        id: e.id,
        decision: e.decision,
        currentLevel: e.currentLevel,
        targetLevel: e.targetLevel,
        eligible: e.eligible,
        confidence: e.confidence,
        progressPercent: e.progressPercent,
        promotionApplied: e.promotionApplied,
        evaluatedAt: e.evaluatedAt,
        triggerSource: e.triggerSource,
        blockingReasons: e.blockingReasonsJson,
        requirements: e.requirementsJson,
      }));
    }

    // 3. Checkpoints summary per skill+level
    const checkpointsSummary: Record<string, unknown> = {};
    for (const s of skillsToCheck) {
      const { data: cpData } = await supabase
        .from('promotion_checkpoints')
        .select('level, passed, confidence, evaluated_at')
        .eq('user_id', userId)
        .eq('skill', s)
        .order('evaluated_at', { ascending: false })
        .limit(20);

      checkpointsSummary[s] = cpData ?? [];
    }

    res.status(200).json({
      userId,
      profiles: profiles.map(p => ({
        skill: p.skill,
        level: p.level,
        status: p.status,
        confidence: p.confidence,
        source: p.source,
        assessedAt: p.assessedAt,
        calibratedAt: p.calibratedAt,
      })),
      evaluations: evaluationsBySkill,
      checkpoints: checkpointsSummary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao obter debug de promoção.';
    jsonError(res, 500, 'INTERNAL_ERROR', message);
  }
}
