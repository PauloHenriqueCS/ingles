import { GrammarMasteryState } from './grammar-mastery-types';

/**
 * Progressões normais (sem motivo obrigatório).
 * Representam o fluxo pedagógico esperado de avanço.
 */
const NORMAL_PROGRESSIONS: Readonly<Record<GrammarMasteryState, readonly GrammarMasteryState[]>> = {
  locked:        ['introduced'],
  introduced:    ['practicing'],
  practicing:    ['consolidating'],
  consolidating: ['mastered'],
  mastered:      ['maintenance'],
  maintenance:   [],
};

/**
 * Regressões válidas (motivo explícito obrigatório).
 * Representam situações em que o aluno demonstrou perda de domínio.
 * Nunca permitir regressão para "locked": um tópico apresentado não pode
 * voltar ao estado "ainda não introduzido".
 */
const VALID_REGRESSIONS: Readonly<Record<GrammarMasteryState, readonly GrammarMasteryState[]>> = {
  locked:        [],
  introduced:    [],
  practicing:    ['introduced'],
  consolidating: ['practicing'],
  mastered:      ['consolidating'],
  maintenance:   ['consolidating', 'practicing'],
};

/**
 * Retorna true se a transição de `from` para `to` é permitida.
 *
 * - Progressões normais: permitidas sem motivo.
 * - Regressões válidas: exigem `reason` não-vazio.
 * - Qualquer outra transição: rejeitada.
 */
export function canTransitionGrammarMastery(
  from: GrammarMasteryState,
  to: GrammarMasteryState,
  reason?: string,
): boolean {
  if (from === to) return false;

  if ((NORMAL_PROGRESSIONS[from] as readonly GrammarMasteryState[]).includes(to)) {
    return true;
  }

  if ((VALID_REGRESSIONS[from] as readonly GrammarMasteryState[]).includes(to)) {
    return Boolean(reason && reason.trim().length > 0);
  }

  return false;
}

export class InvalidGrammarMasteryTransitionError extends Error {
  constructor(from: GrammarMasteryState, to: GrammarMasteryState, reason?: string) {
    const base = `Invalid grammar mastery transition: ${from} → ${to}`;
    const hint = reason ? '' : '. Regressions require a non-empty reason.';
    super(base + hint);
    this.name = 'InvalidGrammarMasteryTransitionError';
  }
}

export function assertTransitionAllowed(
  from: GrammarMasteryState,
  to: GrammarMasteryState,
  reason?: string,
): void {
  if (!canTransitionGrammarMastery(from, to, reason)) {
    throw new InvalidGrammarMasteryTransitionError(from, to, reason);
  }
}
