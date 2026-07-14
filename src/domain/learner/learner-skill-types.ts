import { CEFRLevel } from '../curriculum/cefr';

export type { CEFRLevel };

export type LearningSkill =
  | 'writing'
  | 'pronunciation'
  | 'conversation'
  | 'listening';

export const LEARNING_SKILLS: readonly LearningSkill[] = [
  'writing',
  'pronunciation',
  'conversation',
  'listening',
] as const;

export type SkillAssessmentStatus =
  | 'unknown'
  | 'provisional'
  | 'calibrating'
  | 'confirmed'
  | 'stale';

export const SKILL_ASSESSMENT_STATUSES: readonly SkillAssessmentStatus[] = [
  'unknown',
  'provisional',
  'calibrating',
  'confirmed',
  'stale',
] as const;

export type SkillLevelSource =
  | 'diagnostic'
  | 'ongoing_calibration'
  | 'checkpoint'
  | 'manual_admin'
  | 'legacy_migration'
  | 'system_default';

export const SKILL_LEVEL_SOURCES: readonly SkillLevelSource[] = [
  'diagnostic',
  'ongoing_calibration',
  'checkpoint',
  'manual_admin',
  'legacy_migration',
  'system_default',
] as const;

export interface LearnerSkillProfile {
  id: string;
  userId: string;
  skill: LearningSkill;
  level: CEFRLevel | null;
  status: SkillAssessmentStatus;
  /** 0–1. Nunca usar valores percentuais (0–100) internamente. */
  confidence: number;
  source: SkillLevelSource;
  evidenceCount: number;
  catalogVersion: number;
  assessedAt: string | null;
  calibratedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearnerSkillLevelHistory {
  id: string;
  userId: string;
  skill: LearningSkill;
  previousLevel: CEFRLevel | null;
  newLevel: CEFRLevel | null;
  previousStatus: SkillAssessmentStatus;
  newStatus: SkillAssessmentStatus;
  previousConfidence: number;
  newConfidence: number;
  source: SkillLevelSource;
  reasonCode: string;
  /** JSONB controlado: apenas resumo de evidências, sem prompts ou textos completos. */
  evidenceSnapshot: Record<string, unknown> | null;
  changedAt: string;
}

/**
 * Tipo canônico para dificuldade de conteúdo.
 * Mantido separado de CEFRLevel: dificuldade varia dentro do mesmo nível.
 * Nunca faça: easy=A1, medium=B1, hard=C1.
 */
export type ContentDifficulty = 'easy' | 'medium' | 'hard';
