/**
 * Estados de domínio por tópico gramatical.
 *
 * locked        - Ainda não deve ser cobrado; exposição incidental permitida.
 * introduced    - Apresentado, pouca ou nenhuma evidência de uso.
 * practicing    - Oportunidades guiadas iniciadas; ainda há erros ou dependência de ajuda.
 * consolidating - Uso razoável demonstrado; precisa confirmar retenção em novos contextos.
 * mastered      - Domínio suficiente conforme as regras do motor de evidências.
 * maintenance   - Dominado, em revisão espaçada para evitar perda de retenção.
 */
export type GrammarMasteryState =
  | 'locked'
  | 'introduced'
  | 'practicing'
  | 'consolidating'
  | 'mastered'
  | 'maintenance';

export const GRAMMAR_MASTERY_STATES: readonly GrammarMasteryState[] = [
  'locked',
  'introduced',
  'practicing',
  'consolidating',
  'mastered',
  'maintenance',
] as const;

export interface LearnerGrammarMastery {
  id: string;
  userId: string;
  /** ID canônico do tópico no catálogo (ex: "grammar.present_simple"). */
  grammarTopicId: string;
  catalogVersion: number;

  state: GrammarMasteryState;

  /** Total de oportunidades de usar a estrutura (tentadas ou não). */
  totalOpportunities: number;
  /** Usos bem-sucedidos da estrutura. Sempre <= totalOpportunities. */
  successfulUses: number;
  errorCount: number;

  /** Usos sem assistência ou orientação. */
  independentUses: number;
  /** Usos com orientação do sistema (prompt direcionado). */
  guidedUses: number;
  /** Usos com assistência explícita (correção imediata). */
  assistedUses: number;

  /**
   * Número de contextos/temas distintos em que o tópico foi praticado.
   * Contextos distintos indicam transferência de aprendizado.
   */
  distinctContextCount: number;

  /** 0–1. Nunca usar valores percentuais internamente. */
  confidence: number;

  firstIntroducedAt: string | null;
  lastPracticedAt: string | null;
  lastSuccessfulUseAt: string | null;
  masteredAt: string | null;
  maintenanceDueAt: string | null;

  createdAt: string;
  updatedAt: string;
}
