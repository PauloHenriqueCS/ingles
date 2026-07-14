/**
 * SERVER-ONLY: Serviço de diagnóstico de escrita.
 * Nunca importar em código client-side (src/).
 *
 * Responsabilidades:
 * - Verificar elegibilidade do usuário para diagnóstico invisível
 * - Determinar o status atual do diagnóstico
 * - Coordenar geração, validação e persistência das missões diagnósticas
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  getActiveDiagnosticMissions,
  getWritingProfile,
  supersedeActiveDiagnosticMissions,
  insertDiagnosticMission,
  incrementDiagnosticRegenerationCount,
  DiagnosticMissionRow,
} from './_diagnostic-repository';

// Importações do domínio (puro, sem dependências de browser)
import {
  resolveWritingDiagnosticStatus,
  isEligibleForWritingDiagnostic,
  nextDiagnosticSequence,
} from '../src/domain/diagnostic/writing-diagnostic-status';
import type { WritingDiagnosticStatus } from '../src/domain/diagnostic/writing-diagnostic-status';
import {
  createDiagnosticPlan,
} from '../src/domain/diagnostic/writing-diagnostic-planner';
import {
  validateDiagnosticMission,
  DIAGNOSTIC_VALIDATOR_VERSION,
} from '../src/domain/diagnostic/writing-diagnostic-validator';
import type {
  WritingDiagnosticMissionPlan,
  DiagnosticRejectionLogEntry,
} from '../src/domain/diagnostic/writing-diagnostic-types';
import { safeLog } from './_helpers';

// ── Feature flag ──────────────────────────────────────────────────────────────

/**
 * Verifica se o modo diagnóstico de escrita está habilitado.
 * Lê exclusivamente do ambiente do servidor — nunca exposto ao browser.
 */
export function isWritingDiagnosticEnabled(): boolean {
  const flag = process.env.WRITING_DIAGNOSTIC_V1;
  return flag === 'true' || flag === '1';
}

// ── Versão do prompt diagnóstico ─────────────────────────────────────────────

export const DIAGNOSTIC_PROMPT_VERSION = 'v1' as const;

// ── Status do diagnóstico ─────────────────────────────────────────────────────

/**
 * Retorna o status atual do diagnóstico de escrita do usuário.
 * Combina o perfil de skill com as missões diagnósticas ativas.
 */
export async function getWritingDiagnosticStatus(
  supabase: SupabaseClient,
  userId: string,
): Promise<WritingDiagnosticStatus> {
  const [profile, missions] = await Promise.all([
    getWritingProfile(supabase, userId),
    getActiveDiagnosticMissions(supabase, userId),
  ]);

  const profileForStatus = profile
    ? { level: profile.level, status: profile.assessment_status }
    : null;

  const missionsForStatus = missions.map(m => ({
    diagnosticSequence: m.diagnostic_sequence,
    status: m.status,
  }));

  return resolveWritingDiagnosticStatus(profileForStatus, missionsForStatus);
}

// ── Contexto diagnóstico para geração ────────────────────────────────────────

export interface DiagnosticGenerationContext {
  /** Deve usar modo diagnóstico? */
  shouldUseDiagnostic: boolean;
  /** Sequência a gerar (1 ou 2). Null = não gerar diagnóstico. */
  diagnosticSequence: 1 | 2 | null;
  /** Missão ativa existente (retornar ao invés de gerar nova). */
  existingActiveMission: DiagnosticMissionRow | null;
  /** Plano diagnóstico criado para a geração. */
  diagnosticPlan: WritingDiagnosticMissionPlan | null;
  /** Status atual do diagnóstico. */
  status: WritingDiagnosticStatus;
}

/**
 * Determina o contexto de geração diagnóstica para o usuário.
 *
 * Lógica:
 * - Se feature flag desligada → shouldUseDiagnostic = false
 * - Se usuário não elegível → shouldUseDiagnostic = false
 * - Se missão já ativa e nenhum previousThemeId → retornar existente (idempotência)
 * - Se deve gerar nova → determinar sequência e criar plano
 */
export async function getDiagnosticGenerationContext(
  supabase: SupabaseClient,
  userId: string,
  previousThemeId: string | null,
): Promise<DiagnosticGenerationContext> {
  const noopContext: DiagnosticGenerationContext = {
    shouldUseDiagnostic: false,
    diagnosticSequence: null,
    existingActiveMission: null,
    diagnosticPlan: null,
    status: 'ineligible',
  };

  if (!isWritingDiagnosticEnabled()) return noopContext;

  const profile = await getWritingProfile(supabase, userId);
  const profileForEligibility = profile
    ? { level: profile.level, status: profile.assessment_status }
    : null;

  if (!isEligibleForWritingDiagnostic(profileForEligibility)) return noopContext;

  const missions = await getActiveDiagnosticMissions(supabase, userId);
  const missionsForStatus = missions.map(m => ({
    diagnosticSequence: m.diagnostic_sequence,
    status: m.status,
  }));
  const profileForStatus = profileForEligibility;

  const currentStatus = resolveWritingDiagnosticStatus(profileForStatus, missionsForStatus);

  // Estados que não demandam geração diagnóstica
  if (
    currentStatus === 'ready_for_classification' ||
    currentStatus === 'classified' ||
    currentStatus === 'ineligible'
  ) {
    return noopContext;
  }

  // Missão 2 só pode ser gerada após missão 1 concluída
  if (
    (currentStatus === 'mission_1_generated') &&
    previousThemeId
  ) {
    // Usuário está regenerando (Gerar outro tema) dentro da missão 1
    const activeMission1 = missions.find(m => m.diagnostic_sequence === 1);
    if (activeMission1?.accepted_at) {
      // Missão já aceita — não pode ser substituída silenciosamente
      return noopContext;
    }
    return {
      shouldUseDiagnostic: true,
      diagnosticSequence: 1,
      existingActiveMission: null,
      diagnosticPlan: createDiagnosticPlan(1),
      status: currentStatus,
    };
  }

  if (currentStatus === 'mission_1_generated' && !previousThemeId) {
    // Idempotência: retornar missão existente
    const existingMission = missions.find(m => m.diagnostic_sequence === 1 && m.status === 'generated');
    if (existingMission) {
      return {
        shouldUseDiagnostic: true,
        diagnosticSequence: 1,
        existingActiveMission: existingMission,
        diagnosticPlan: existingMission.diagnostic_plan as WritingDiagnosticMissionPlan,
        status: currentStatus,
      };
    }
  }

  if (currentStatus === 'mission_2_generated' && !previousThemeId) {
    // Idempotência: retornar missão 2 existente
    const existingMission = missions.find(m => m.diagnostic_sequence === 2 && m.status === 'generated');
    if (existingMission) {
      return {
        shouldUseDiagnostic: true,
        diagnosticSequence: 2,
        existingActiveMission: existingMission,
        diagnosticPlan: existingMission.diagnostic_plan as WritingDiagnosticMissionPlan,
        status: currentStatus,
      };
    }
  }

  if (currentStatus === 'mission_2_generated' && previousThemeId) {
    // Usuário está regenerando dentro da missão 2
    const activeMission2 = missions.find(m => m.diagnostic_sequence === 2);
    if (activeMission2?.accepted_at) {
      return noopContext; // Missão aceita — não substituir
    }
    return {
      shouldUseDiagnostic: true,
      diagnosticSequence: 2,
      existingActiveMission: null,
      diagnosticPlan: createDiagnosticPlan(2),
      status: currentStatus,
    };
  }

  const sequence = nextDiagnosticSequence(currentStatus);
  if (!sequence) return noopContext;

  return {
    shouldUseDiagnostic: true,
    diagnosticSequence: sequence,
    existingActiveMission: null,
    diagnosticPlan: createDiagnosticPlan(sequence),
    status: currentStatus,
  };
}

// ── Persistência da missão diagnóstica ───────────────────────────────────────

export interface SaveDiagnosticMissionParams {
  userId: string;
  themeId: string;
  diagnosticSequence: 1 | 2;
  plan: WritingDiagnosticMissionPlan;
  rejectionLog: DiagnosticRejectionLogEntry[];
  objectiveIds: string[];
}

/**
 * Persiste a missão diagnóstica gerada.
 *
 * Se previousThemeId foi fornecido (regeneração), marca missões anteriores
 * da mesma sequência como 'superseded' antes de inserir a nova.
 *
 * Retorna o ID do registro criado, ou null em caso de erro/conflito.
 */
export async function saveDiagnosticMission(
  params: SaveDiagnosticMissionParams,
  previousThemeId: string | null,
): Promise<string | null> {
  // Marcar missões anteriores como superseded (regeneração)
  if (previousThemeId) {
    await supersedeActiveDiagnosticMissions(params.userId, params.diagnosticSequence);
    await incrementDiagnosticRegenerationCount(params.userId, params.diagnosticSequence);
  }

  const row = await insertDiagnosticMission({
    userId: params.userId,
    themeId: params.themeId,
    diagnosticSequence: params.diagnosticSequence,
    catalogVersion: params.plan.catalogVersion,
    diagnosticPlan: params.plan as unknown as Record<string, unknown>,
    objectiveIds: params.objectiveIds,
    rejectionLog: params.rejectionLog,
    promptVersion: DIAGNOSTIC_PROMPT_VERSION,
    validatorVersion: DIAGNOSTIC_VALIDATOR_VERSION,
  });

  return row?.id ?? null;
}

// ── Observabilidade ───────────────────────────────────────────────────────────

export function logDiagnosticEvent(
  event: string,
  userId: string,
  extra?: Record<string, string | number | boolean | null>,
): void {
  safeLog('diagnostic', event, 200, {
    user_id_hash: hashUserId(userId),
    ...extra,
  });
}

function hashUserId(userId: string): string {
  // Não usa crypto complexo — apenas prefixo para distinguir sem expor ID completo
  return `u_${userId.slice(0, 8)}`;
}

// ── Validação da geração ──────────────────────────────────────────────────────

/**
 * Realiza a validação pós-geração de uma missão diagnóstica.
 * Retorna o candidato normalizado se válido, ou null com o código de rejeição.
 */
export function validateGeneratedDiagnosticMission(
  plan: WritingDiagnosticMissionPlan,
  rawMission: Record<string, unknown>,
  recentThemes: Array<{ title: string | null; semantic_summary: string | null }>,
  attempt: number,
  existingLog: DiagnosticRejectionLogEntry[],
): { valid: boolean; updatedLog: DiagnosticRejectionLogEntry[] } {
  const result = validateDiagnosticMission(plan, rawMission, recentThemes);

  if (result.valid) {
    return { valid: true, updatedLog: existingLog };
  }

  const entry: DiagnosticRejectionLogEntry = {
    attempt,
    rejectionCode: result.rejectionCode ?? 'UNKNOWN',
    rejectionDetail: result.rejectionDetail ?? '',
    timestamp: new Date().toISOString(),
  };

  return { valid: false, updatedLog: [...existingLog, entry] };
}
