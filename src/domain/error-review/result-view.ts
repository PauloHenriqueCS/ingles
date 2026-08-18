/**
 * Pure builder for the error-review RESULT view model.
 *
 * ROOT CAUSE it fixes: the feedback card used to render `result.originalValue`
 * (the ORIGINAL error the item is reviewing) under the label "Sua resposta",
 * showing the student a phrase they never submitted (e.g. "that trip had
 * memorable") instead of what they actually wrote ("the trip was memorable").
 *
 * The submitted answer is AUTHORITATIVE and comes from the code: it is exactly
 * the string the client sent to submit_error_review_item for THIS attempt (the
 * backend persists that same string in review_item_attempts.submitted_text). It
 * is never the original error, never the expected correction, and never a value
 * reconstructed by anything else.
 *
 * This builder also protects against a stale / out-of-order async response: it
 * only produces a view when the answered item is still the current item, so a
 * late response for a previous card can never overwrite the current card's
 * feedback.
 */

/** The pedagogical fields the deterministic backend returns for an attempt. */
export interface ErrorReviewEvaluation {
  passed: boolean;
  /** The expected corrected form (authoritative expected value). */
  correctedValue: string;
  /** The ORIGINAL error under review — NOT the student's submitted answer. */
  originalValue: string;
  explanation: string | null;
  mastered: boolean;
}

export interface ErrorReviewResultView extends ErrorReviewEvaluation {
  /**
   * Exactly the text the student submitted for THIS attempt. Authoritative,
   * immutable for the lifetime of this result. Displayed under "Sua resposta".
   */
  submittedAnswer: string;
  /** The item this result belongs to (guards against cross-card mismatch). */
  itemId: string;
}

/**
 * Build the result view for a submission, binding the authoritative submitted
 * answer to the evaluation. Returns null when the response is stale (the item
 * has changed since submit) so it is dropped instead of applied to another card.
 */
export function buildResultView(
  evaluation: ErrorReviewEvaluation,
  submittedAnswer: string,
  submittedItemId: string,
  currentItemId: string | null | undefined,
): ErrorReviewResultView | null {
  if (!submittedItemId || submittedItemId !== currentItemId) return null;
  return {
    passed: evaluation.passed,
    correctedValue: evaluation.correctedValue,
    originalValue: evaluation.originalValue,
    explanation: evaluation.explanation,
    mastered: evaluation.mastered,
    submittedAnswer,
    itemId: submittedItemId,
  };
}
