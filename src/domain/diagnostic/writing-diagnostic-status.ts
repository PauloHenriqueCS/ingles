/**
 * Estado atual do diagnóstico de escrita de um aluno.
 *
 * Usado server-side para determinar qual missão diagnóstica gerar.
 * NUNCA exposto ao browser como campo explícito — o aluno não sabe que existe
 * um diagnóstico em andamento.
 */
export type WritingDiagnosticStatus =
  | 'not_started'            // Nenhuma missão diagnóstica gerada ainda
  | 'mission_1_generated'    // Missão 1 gerada/ativa, aguardando conclusão
  | 'mission_1_completed'    // Texto elegível submetido para missão 1
  | 'mission_2_generated'    // Missão 2 gerada/ativa, aguardando conclusão
  | 'ready_for_classification' // Ambas as missões concluídas — pronto para Task 8
  | 'classified'             // Nível de writing já atribuído
  | 'ineligible';            // Usuário não passa nos critérios de elegibilidade

/**
 * Determina se um usuário é elegível para o diagnóstico invisível de escrita.
 *
 * Elegível: perfil de writing com level = null E status = 'unknown'.
 * Não elegível: qualquer outro estado (provisional, confirmed, stale, etc.)
 * ou se não existir perfil.
 */
export function isEligibleForWritingDiagnostic(writingProfile: {
  level: string | null;
  status: string;
} | null): boolean {
  if (!writingProfile) return false;
  return writingProfile.level === null && writingProfile.status === 'unknown';
}

/**
 * Resolve o WritingDiagnosticStatus a partir dos dados do banco.
 *
 * Lógica:
 * - Se o perfil de writing já tem nível → 'classified'
 * - Se o perfil de writing tem status != 'unknown' → 'ineligible'
 * - Se não há missões diagnósticas → 'not_started'
 * - Se a missão 2 está completed → 'ready_for_classification'
 * - Se a missão 2 está generated → 'mission_2_generated'
 * - Se a missão 1 está completed → 'mission_1_completed'
 * - Se a missão 1 está generated → 'mission_1_generated'
 */
export function resolveWritingDiagnosticStatus(
  writingProfile: { level: string | null; status: string } | null,
  activeMissions: Array<{ diagnosticSequence: 1 | 2; status: string }>,
): WritingDiagnosticStatus {
  if (!writingProfile) return 'ineligible';

  if (writingProfile.level !== null) return 'classified';
  if (writingProfile.status !== 'unknown') return 'ineligible';

  const mission1 = activeMissions.find(m => m.diagnosticSequence === 1);
  const mission2 = activeMissions.find(m => m.diagnosticSequence === 2);

  if (mission2?.status === 'completed') return 'ready_for_classification';
  if (mission2?.status === 'generated') return 'mission_2_generated';
  if (mission1?.status === 'completed') return 'mission_1_completed';
  if (mission1?.status === 'generated') return 'mission_1_generated';

  return 'not_started';
}

/**
 * Determina qual sequência diagnóstica deve ser gerada com base no status atual.
 * Retorna null se não deve gerar diagnóstico.
 */
export function nextDiagnosticSequence(
  status: WritingDiagnosticStatus,
): 1 | 2 | null {
  if (status === 'not_started') return 1;
  if (status === 'mission_1_completed') return 2;
  return null; // not_started handled, mission_1_generated = return existing, others = no diagnostic
}
