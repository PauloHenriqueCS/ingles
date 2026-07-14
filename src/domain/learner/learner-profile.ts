import { CEFRLevel } from '../curriculum/cefr';
import { CURRENT_CATALOG_VERSION, LEGACY_MIGRATION_CONFIDENCE, PEDAGOGICAL_FALLBACK_LEVEL } from './constants';
import { LearnerSkillProfile, LearningSkill, LEARNING_SKILLS, SkillAssessmentStatus } from './learner-skill-types';

/**
 * Retorna o nível efetivo da habilidade.
 *
 * Distingue explicitamente entre:
 * - nível real classificado (isFallback = false)
 * - fallback operacional temporário (isFallback = true)
 *
 * O fallback nunca deve ser persistido como avaliação real.
 */
export function getEffectiveSkillLevel(
  profile: LearnerSkillProfile | null | undefined,
  fallbackLevel: CEFRLevel = PEDAGOGICAL_FALLBACK_LEVEL,
): { level: CEFRLevel; isFallback: boolean } {
  if (profile?.level != null && profile.status !== 'unknown') {
    return { level: profile.level, isFallback: false };
  }
  return { level: fallbackLevel, isFallback: true };
}

/**
 * Cria o perfil inicial de uma habilidade para um novo usuário.
 * Nível = null, status = unknown, confiança = 0.
 *
 * Ausência de classificação não é equivalente a A1.
 */
export function createInitialSkillProfile(
  userId: string,
  skill: LearningSkill,
): Omit<LearnerSkillProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    userId,
    skill,
    level: null,
    status: 'unknown',
    confidence: 0,
    source: 'system_default',
    evidenceCount: 0,
    catalogVersion: CURRENT_CATALOG_VERSION,
    assessedAt: null,
    calibratedAt: null,
  };
}

/**
 * Cria os quatro perfis iniciais de habilidade para um novo usuário.
 * Todas as habilidades começam como unknown.
 */
export function createInitialSkillProfiles(
  userId: string,
): Omit<LearnerSkillProfile, 'id' | 'createdAt' | 'updatedAt'>[] {
  return LEARNING_SKILLS.map(skill => createInitialSkillProfile(userId, skill));
}

/**
 * Cria um perfil de habilidade a partir de um nível legado.
 * Aplica confiança conservadora e marca como legacy_migration.
 *
 * Deve ser usado APENAS para writing — não copiar para pronunciation,
 * conversation ou listening, pois o nível legado era escrita.
 */
export function createLegacyMigratedProfile(
  userId: string,
  skill: 'writing',
  legacyLevel: CEFRLevel,
): Omit<LearnerSkillProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    userId,
    skill,
    level: legacyLevel,
    status: 'provisional',
    confidence: LEGACY_MIGRATION_CONFIDENCE,
    source: 'legacy_migration',
    evidenceCount: 0,
    catalogVersion: CURRENT_CATALOG_VERSION,
    assessedAt: null,
    calibratedAt: null,
  };
}

/**
 * Resolve o nível efetivo para uso operacional (geração de conteúdo),
 * priorizando o perfil novo e usando o legado apenas para writing.
 *
 * Esta é uma função pura — não acessa banco. O chamador deve fornecer os dados.
 *
 * Para pronunciation, conversation e listening: nunca herda o nível legado.
 * Para listening: sempre retorna null (funcionalidade futura).
 */
export function resolveLegacyEffectiveLevel(
  profiles: LearnerSkillProfile[],
  skill: LearningSkill,
  legacyWritingLevel: CEFRLevel | null,
): { level: CEFRLevel; isFallback: boolean } | { level: null; isFallback: true } {
  const profile = profiles.find(p => p.skill === skill);

  if (profile?.level != null && profile.status !== 'unknown') {
    return { level: profile.level, isFallback: false };
  }

  if (skill === 'writing' && legacyWritingLevel != null) {
    return { level: legacyWritingLevel, isFallback: true };
  }

  if (skill === 'listening') {
    return { level: null, isFallback: true };
  }

  return { level: null, isFallback: true };
}

export const ALL_SKILLS_UNKNOWN = LEARNING_SKILLS;

/**
 * Determina se uma alteração de nível ou status deve gerar registro no histórico.
 * Pura e testável sem acesso a banco.
 *
 * Regra: registra histórico apenas quando o nível ou o status efetivamente mudar.
 * Alterações apenas de contadores de evidências não criam histórico de nível.
 */
export function shouldCreateLevelHistory(
  previousLevel: CEFRLevel | null,
  newLevel: CEFRLevel | null,
  previousStatus: SkillAssessmentStatus,
  newStatus: SkillAssessmentStatus,
): boolean {
  return previousLevel !== newLevel || previousStatus !== newStatus;
}
