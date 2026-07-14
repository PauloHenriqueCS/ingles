/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { CEFRLevel, ALL_CEFR_LEVELS } from '../domain/curriculum/cefr';
import { LearnerSkillProfile, LearningSkill, SkillAssessmentStatus, SkillLevelSource } from '../domain/learner/learner-skill-types';
import { createInitialSkillProfiles, createLegacyMigratedProfile } from '../domain/learner/learner-profile';
import { validateConfidence, validateCefrLevel, validateSkillAssessmentStatus, validateSkillLevelSource } from '../domain/learner/learner-profile-validation';
import { getLearnerSkillProfiles, getLearnerSkillProfile, upsertLearnerSkillProfile, insertSkillLevelHistory } from './learnerProfileRepository';

const CEFR_SET = new Set<string>(ALL_CEFR_LEVELS as CEFRLevel[]);

// ── Inicialização ─────────────────────────────────────────────────────────────

/**
 * Garante que o usuário possui perfis pedagógicos para todas as quatro
 * habilidades. Idempotente: não sobrescreve perfis existentes.
 */
export async function initializeLearnerPedagogicalProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerSkillProfile[]> {
  const existing = await getLearnerSkillProfiles(supabase, userId);
  const existingSkills = new Set(existing.map(p => p.skill));

  const toCreate = createInitialSkillProfiles(userId).filter(
    p => !existingSkills.has(p.skill),
  );

  for (const profile of toCreate) {
    await upsertLearnerSkillProfile(supabase, profile);
  }

  return getLearnerSkillProfiles(supabase, userId);
}

// ── Atualização pedagógica ────────────────────────────────────────────────────

export interface UpdateLearnerSkillAssessmentParams {
  userId: string;
  skill: LearningSkill;
  newLevel: CEFRLevel | null;
  newStatus: SkillAssessmentStatus;
  newConfidence: number;
  source: SkillLevelSource;
  reasonCode: string;
  evidenceSnapshot?: Record<string, unknown>;
  evidenceCount?: number;
}

/**
 * Atualiza a avaliação de habilidade do aluno e registra histórico se o
 * nível ou status mudou. Opera de forma transacional via upsert + insert.
 *
 * Validações aplicadas antes de qualquer escrita:
 * - confidence entre 0 e 1
 * - level null ou A1–C2
 * - status e source em enums canônicos
 *
 * Histórico criado apenas quando level ou status mudar.
 * Alterações de evidenceCount sem mudança de level/status não geram histórico.
 */
export async function updateLearnerSkillAssessment(
  supabase: SupabaseClient,
  params: UpdateLearnerSkillAssessmentParams,
): Promise<LearnerSkillProfile> {
  const { userId, skill, newLevel, newStatus, newConfidence, source, reasonCode, evidenceSnapshot, evidenceCount } = params;

  validateConfidence(newConfidence);
  validateCefrLevel(newLevel);
  validateSkillAssessmentStatus(newStatus);
  validateSkillLevelSource(source);

  const current = await getLearnerSkillProfile(supabase, userId, skill);

  const levelChanged = current?.level !== newLevel;
  const statusChanged = current?.status !== newStatus;

  const updated = await upsertLearnerSkillProfile(supabase, {
    userId,
    skill,
    level: newLevel,
    status: newStatus,
    confidence: newConfidence,
    source,
    evidenceCount: evidenceCount ?? (current?.evidenceCount ?? 0),
    catalogVersion: current?.catalogVersion ?? 1,
    assessedAt: newLevel != null ? new Date().toISOString() : (current?.assessedAt ?? null),
    calibratedAt: current?.calibratedAt ?? null,
  });

  if (levelChanged || statusChanged) {
    await insertSkillLevelHistory(supabase, {
      userId,
      skill,
      previousLevel: current?.level ?? null,
      newLevel,
      previousStatus: current?.status ?? 'unknown',
      newStatus,
      previousConfidence: current?.confidence ?? 0,
      newConfidence,
      source,
      reasonCode,
      evidenceSnapshot: evidenceSnapshot ?? null,
      changedAt: new Date().toISOString(),
    });
  }

  return updated;
}

// ── Migração legada ───────────────────────────────────────────────────────────

/**
 * Migra o nível legado (english_learning_memory.current_level) para o perfil
 * de writing. Aplica confiança conservadora e marca como legacy_migration.
 *
 * NÃO migra para pronunciation, conversation ou listening — o nível legado
 * era derivado de escrita. Migração idempotente: respeita perfil existente.
 */
export async function migrateLegacyLearnerLevel(
  supabase: SupabaseClient,
  userId: string,
  legacyLevel: string,
): Promise<LearnerSkillProfile | null> {
  if (!CEFR_SET.has(legacyLevel)) return null;

  const existing = await getLearnerSkillProfile(supabase, userId, 'writing');

  // Não sobrescreve se já foi migrado ou classificado por fonte mais confiável
  if (
    existing &&
    existing.source !== 'system_default' &&
    existing.status !== 'unknown'
  ) {
    return existing;
  }

  const profile = createLegacyMigratedProfile(userId, 'writing', legacyLevel as CEFRLevel);
  return upsertLearnerSkillProfile(supabase, profile);
}

// ── Leitura por skill (proxy público) ────────────────────────────────────────

export { getLearnerSkillProfiles, getLearnerSkillProfile };
