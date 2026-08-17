import { ERROR_REVIEW_INTERVAL_DAYS, ERROR_REVIEW_MASTERED_LEVEL } from './constants';

export interface ScheduleTransition {
  /** Novo nível do card após a submissão. */
  newLevel: number;
  /** 'scheduled' enquanto o card continua em revisão; 'mastered' quando dominado. */
  newStatus: 'scheduled' | 'mastered';
  /** Dias até a próxima revisão, ou null quando dominado. */
  intervalDays: number | null;
  /** true quando este acerto dominou o card. */
  mastered: boolean;
}

/**
 * Ciclo de repetição espaçada POR ITEM — referência testada, espelhada pela RPC
 * submit_error_review_item (a fonte da verdade em produção é a RPC; esta função
 * documenta e valida a mesma regra determinística).
 *
 *   acertou no nível 0 → nível 1 (+7)
 *   acertou no nível 1 → nível 2 (+30)
 *   acertou no nível 2 → nível 3 (+120)
 *   acertou no nível 3 → mastered
 *   errou (qualquer nível) → nível 0 (+1)
 */
export function computeNextSchedule(currentLevel: number, passed: boolean): ScheduleTransition {
  if (!passed) {
    return { newLevel: 0, newStatus: 'scheduled', intervalDays: ERROR_REVIEW_INTERVAL_DAYS[0], mastered: false };
  }
  if (currentLevel >= 3) {
    return { newLevel: ERROR_REVIEW_MASTERED_LEVEL, newStatus: 'mastered', intervalDays: null, mastered: true };
  }
  const newLevel = currentLevel + 1;
  return {
    newLevel,
    newStatus: 'scheduled',
    intervalDays: ERROR_REVIEW_INTERVAL_DAYS[newLevel],
    mastered: false,
  };
}
