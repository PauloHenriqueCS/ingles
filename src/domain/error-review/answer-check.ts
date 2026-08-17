/**
 * Validação determinística da resposta de revisão — espelha a função SQL
 * error_review_normalize + a regra de acerto da RPC submit_error_review_item.
 *
 * Objetivos (item #17):
 *   * ignorar diferenças irrelevantes de caixa, espaços e pontuação de borda;
 *   * NÃO aceitar uma resposta que apenas preserve o erro sob revisão;
 *   * ser determinística e testável (sem IA).
 *
 * A pontuação de BORDA (início/fim) é removida; pontuação interna é preservada
 * para não alterar a correção avaliada.
 */

const EDGE_PUNCTUATION = ` \t\n\r.,!?;:"'\`()[]{}`;

export function normalizeAnswer(text: string | null | undefined): string {
  const lowered = (text ?? '').toLowerCase().replace(/\s+/g, ' ');
  return trimChars(lowered, EDGE_PUNCTUATION);
}

function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start++;
  while (end > start && chars.includes(value[end - 1])) end--;
  return value.slice(start, end);
}

/**
 * Retorna true quando a resposta submetida corresponde à forma correta e não é
 * apenas a manutenção do erro original. Quando a forma correta e a errada são
 * iguais após normalização (diferença puramente cosmética), a segunda cláusula
 * é dispensada.
 */
export function isAnswerCorrect(
  submitted: string,
  correctedValue: string,
  originalValue: string,
): boolean {
  const sub = normalizeAnswer(submitted);
  const cor = normalizeAnswer(correctedValue);
  const org = normalizeAnswer(originalValue);
  if (sub !== cor) return false;
  return cor === org || sub !== org;
}
