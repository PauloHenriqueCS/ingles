/**
 * "Revisar meus erros" — constantes da atividade independente de revisão.
 *
 * O limite diário é a REGRA FUNCIONAL desta história (item #11/#23): até 10
 * exercícios por dia. Vive aqui, no código, e é passado como parâmetro para as
 * RPCs (get_error_review_session / submit_error_review_item) — nunca embutido
 * no SQL. Não é um preço/entitlement de plano: a revisão é complementar e
 * independente do currículo e da configuração comercial.
 */
export const ERROR_REVIEW_DAILY_LIMIT = 10;

/**
 * Intervalos de repetição espaçada, em dias, indexados pelo NÍVEL ALVO após um
 * acerto. Nível 0 = erro novo (primeira revisão em +1 dia). Acertar no nível 3
 * (intervalo de 120 dias) leva a `mastered`.
 *
 *   novo(0) → +1 → (acertou) +7 → (acertou) +30 → (acertou) +120 → (acertou) mastered
 *   errar em qualquer etapa → volta ao nível 0 (+1 dia)
 *
 * Espelhado 1:1 pela RPC submit_error_review_item.
 */
export const ERROR_REVIEW_INTERVAL_DAYS: Record<number, number> = {
  0: 1,
  1: 7,
  2: 30,
  3: 120,
};

/** Nível a partir do qual um acerto domina o card (mastered). */
export const ERROR_REVIEW_MASTERED_LEVEL = 4;
