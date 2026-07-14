import { requireAuth } from '../_auth';
import { methodGuard, jsonError } from '../_helpers';
import { evaluateSkillPromotion } from '../../src/lib/promotionService';
import type { PromotionTrigger } from '../../src/domain/promotion/promotion-types';

const VALID_SKILLS = ['writing', 'pronunciation', 'conversation'] as const;
type ValidSkill = typeof VALID_SKILLS[number];

function isValidSkill(s: unknown): s is ValidSkill {
  return typeof s === 'string' && (VALID_SKILLS as readonly string[]).includes(s);
}

function isValidTrigger(t: unknown): t is PromotionTrigger {
  const valid = [
    'mission_completed', 'checkpoint_completed', 'evidence_processed',
    'topic_mastered', 'session_ended', 'admin_recalculate', 'job', 'retry',
  ];
  return typeof t === 'string' && valid.includes(t);
}

export default async function handler(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { userId } = auth;
  const body = req.body ?? {};

  const { skill, trigger, idempotencyKey } = body as {
    skill?: unknown;
    trigger?: unknown;
    idempotencyKey?: unknown;
  };

  if (!isValidSkill(skill)) {
    jsonError(res, 400, 'INVALID_REQUEST', 'skill deve ser writing, pronunciation ou conversation.');
    return;
  }

  const resolvedTrigger: PromotionTrigger =
    isValidTrigger(trigger) ? trigger : 'mission_completed';

  const resolvedKey: string =
    typeof idempotencyKey === 'string' && idempotencyKey.length > 0
      ? idempotencyKey
      : crypto.randomUUID();

  try {
    const evaluation = await evaluateSkillPromotion({
      userId,
      skill,
      trigger: resolvedTrigger,
      idempotencyKey: resolvedKey,
    });

    res.status(200).json({ evaluation });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro interno ao avaliar promoção.';
    jsonError(res, 500, 'INTERNAL_ERROR', message);
  }
}
