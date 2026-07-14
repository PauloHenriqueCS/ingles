import { supabase } from './supabase';
import type { LearningSkill } from '../domain/learner/learner-skill-types';

export type SkillProgressStatus =
  | 'active'
  | 'insufficient_data'
  | 'pending_recalibration'
  | 'evaluation_pending'
  | 'ready_for_promotion'
  | 'maximum_supported_level'
  | 'configuration_error'
  | 'legacy_data';

export interface SkillOverview {
  skill: LearningSkill;
  currentLevel: string | null;
  targetLevel: string | null;
  progressPercent: number | null;
  confidence: number | null;
  status: SkillProgressStatus;
  blockingReasons: string[];
  lastEvaluatedAt: string | null;
  assessedAt: string | null;
}

function assessmentStatusToSkillStatus(
  assessmentStatus: string,
  promotionDecision: string | null,
): SkillProgressStatus {
  if (promotionDecision === 'maximum_supported_level') return 'maximum_supported_level';
  if (promotionDecision === 'promote' || promotionDecision === 'ready_for_promotion') return 'ready_for_promotion';
  if (promotionDecision === 'configuration_error') return 'configuration_error';
  if (assessmentStatus === 'unknown' || assessmentStatus === 'stale') return 'pending_recalibration';
  if (assessmentStatus === 'provisional' || assessmentStatus === 'calibrating') return 'evaluation_pending';
  return 'active';
}

export async function fetchSkillsOverview(): Promise<SkillOverview[]> {
  const [profilesResult, evaluationsResult] = await Promise.all([
    supabase
      .from('learner_skill_profiles')
      .select('skill, cefr_level, assessment_status, confidence, assessed_at'),
    supabase
      .from('promotion_evaluations')
      .select('skill, target_level, decision, progress_percent, blocking_reasons_json, evaluated_at')
      .order('evaluated_at', { ascending: false }),
  ]);

  const profiles = profilesResult.data ?? [];
  const evaluations = evaluationsResult.data ?? [];

  // Get most recent evaluation per skill
  const latestEvalBySkill: Record<string, typeof evaluations[0]> = {};
  for (const ev of evaluations) {
    const skill = ev.skill as string;
    if (!latestEvalBySkill[skill]) {
      latestEvalBySkill[skill] = ev;
    }
  }

  const skills: LearningSkill[] = ['writing', 'pronunciation', 'conversation'];

  return skills.map((skill): SkillOverview => {
    const profile = profiles.find((p) => p.skill === skill);
    const eval_ = latestEvalBySkill[skill];

    if (!profile) {
      return {
        skill,
        currentLevel: null,
        targetLevel: null,
        progressPercent: null,
        confidence: null,
        status: 'insufficient_data',
        blockingReasons: [],
        lastEvaluatedAt: null,
        assessedAt: null,
      };
    }

    const status = assessmentStatusToSkillStatus(
      String(profile.assessment_status ?? 'unknown'),
      eval_ ? String(eval_.decision) : null,
    );

    return {
      skill,
      currentLevel: profile.cefr_level ? String(profile.cefr_level) : null,
      targetLevel: eval_?.target_level ? String(eval_.target_level) : null,
      progressPercent: eval_?.progress_percent != null ? Number(eval_.progress_percent) : null,
      confidence: profile.confidence != null ? Number(profile.confidence) : null,
      status,
      blockingReasons: Array.isArray(eval_?.blocking_reasons_json)
        ? (eval_.blocking_reasons_json as string[])
        : [],
      lastEvaluatedAt: eval_?.evaluated_at ? String(eval_.evaluated_at) : null,
      assessedAt: profile.assessed_at ? String(profile.assessed_at) : null,
    };
  });
}
