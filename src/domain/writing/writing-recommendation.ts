/**
 * After the V1 feedback the activity ALWAYS lets the user conclude — writing a
 * second version is optional. The interface still recommends the next action
 * adaptively, using a signal that already exists in the evaluation: the number
 * of "principais erros" (main mistakes) the AI reported, which is exactly the
 * list the "Melhorar meu texto" screen turns into revision points.
 *
 * The rule is intentionally simple, deterministic and testable — no arbitrary
 * score thresholds:
 *   - 0 main mistakes  → Caso A: the writing is already good. Primary action is
 *                        "Concluir escrita"; improving is offered as secondary.
 *   - ≥1 main mistake  → Caso B: there are concrete points to fix. Primary action
 *                        is "Melhorar meu texto"; concluding is offered as
 *                        secondary ("Concluir mesmo assim").
 */

export interface ImprovementRecommendation {
  /** true ⇒ Caso B (recommend improving); false ⇒ Caso A (recommend concluding). */
  recommend: boolean;
  /** How many concrete points the learner could still fix (main-mistake count). */
  pointsToImprove: number;
}

export function recommendImprovement(mainMistakesCount: number): ImprovementRecommendation {
  const points = Number.isFinite(mainMistakesCount) && mainMistakesCount > 0
    ? Math.floor(mainMistakesCount)
    : 0;
  return { recommend: points > 0, pointsToImprove: points };
}
