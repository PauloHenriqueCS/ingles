import { CEFRLevel } from '../curriculum/cefr';

/** Versão atual do catálogo gramatical (Task 5). */
export const CURRENT_CATALOG_VERSION = 1 as const;

/**
 * Confiança atribuída a perfis migrados do campo legado current_level.
 * Conservadora porque o dado original era um único nível global sem separação
 * por habilidade e sem fonte auditável de evidências.
 */
export const LEGACY_MIGRATION_CONFIDENCE = 0.35 as const;

/**
 * Nível usado como fallback operacional quando o perfil ainda não foi
 * classificado. Utilizado apenas para geração temporária de conteúdo —
 * nunca deve ser persistido como avaliação real no banco.
 */
export const PEDAGOGICAL_FALLBACK_LEVEL: CEFRLevel = 'A1';
