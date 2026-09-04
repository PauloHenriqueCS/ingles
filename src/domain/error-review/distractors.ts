/**
 * Distratores (alternativas incorretas) da atividade "Revisar meus erros".
 *
 * A atividade é 100% múltipla escolha: cada erro tem a forma correta + 3
 * alternativas incorretas plausíveis. Os 3 distratores são gerados UMA vez, na
 * MESMA chamada de IA que já corrige a Escrita (nunca uma chamada extra), e são
 * persistidos no card (review_group_items.distractors) — revisar um erro NUNCA
 * chama IA de novo.
 *
 * Este módulo é a validação DETERMINÍSTICA (sem IA) da saída da IA. Espelha a
 * normalização de src/domain/error-review/answer-check.ts (a mesma usada pela
 * RPC submit_error_review_item) para comparar candidatos contra a resposta
 * correta e entre si. É usado no servidor (api/review-text.ts, ao validar a
 * resposta estruturada da IA) e no cliente (src/lib/reviewGroups.ts, ao
 * persistir) — defesa em profundidade sobre a mesma regra testável.
 */
import { normalizeAnswer } from './answer-check';

/** Número de alternativas incorretas por erro. */
export const ERROR_REVIEW_DISTRACTOR_COUNT = 3;

/** Total de alternativas exibidas (1 correta + 3 distratores). */
export const ERROR_REVIEW_CHOICE_COUNT = ERROR_REVIEW_DISTRACTOR_COUNT + 1;

/**
 * Sanitiza os distratores propostos pela IA em EXATAMENTE 3 alternativas
 * incorretas limpas, ou retorna null quando não é possível formar 3 válidas
 * (nesse caso o erro simplesmente não vira card de revisão — sem 2ª chamada de
 * IA para "consertar").
 *
 * Regras (não confiamos cegamente na IA):
 *   - cada distrator é uma string não vazia (após trim);
 *   - NUNCA igual à resposta correta (comparação normalizada) — isso também
 *     garante que nenhum distrator seria pontuado como acerto pela RPC de
 *     submissão, cuja regra de "passou" exige bater com a forma correta;
 *   - sem duplicatas entre si (comparação normalizada);
 *   - preserva-se a grafia original do distrator (só a COMPARAÇÃO é normalizada),
 *     para exibir "we is" e não "we is" já achatado.
 *
 * Um distrator igual ao ERRO ORIGINAL é permitido de propósito — a própria
 * forma que o aluno escreveu é uma alternativa plausível e desejável (ex.: o
 * mockup lista "we was" entre as opções).
 */
export function sanitizeDistractors(
  correctedValue: string,
  rawDistractors: unknown,
): string[] | null {
  if (!Array.isArray(rawDistractors)) return null;

  const correctNorm = normalizeAnswer(correctedValue);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of rawDistractors) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const norm = normalizeAnswer(trimmed);
    if (!norm) continue; // vazio após normalização
    if (norm === correctNorm) continue; // nunca igual à correta
    if (seen.has(norm)) continue; // sem duplicatas

    seen.add(norm);
    out.push(trimmed);
    if (out.length === ERROR_REVIEW_DISTRACTOR_COUNT) break;
  }

  return out.length === ERROR_REVIEW_DISTRACTOR_COUNT ? out : null;
}
