import { describe, it, expect } from 'vitest';
import { buildResultView, ErrorReviewEvaluation } from './result-view';

// Deterministic backend evaluation for the reported bug scenario. The original
// error under review is "that trip had memorable"; the expected correction is
// "that trip was memorable". The student submitted "the trip was memorable".
const REPORTED_EVAL: ErrorReviewEvaluation = {
  passed: false,
  correctedValue: 'that trip was memorable',
  originalValue: 'that trip had memorable',
  explanation: 'was, não had',
  mastered: false,
};

describe('buildResultView — "Sua resposta" is the SUBMITTED answer, never the original error', () => {
  it('binds the exact submitted text (the reported bug: it used to show the original error)', () => {
    const view = buildResultView(REPORTED_EVAL, 'the trip was memorable', 'item-1', 'item-1');
    expect(view).not.toBeNull();
    expect(view!.submittedAnswer).toBe('the trip was memorable');
    // MUST NOT be the original error the item is reviewing.
    expect(view!.submittedAnswer).not.toBe('that trip had memorable');
    expect(view!.submittedAnswer).not.toBe(REPORTED_EVAL.originalValue);
    // The pedagogical fields still round-trip unchanged.
    expect(view!.correctedValue).toBe('that trip was memorable');
    expect(view!.originalValue).toBe('that trip had memorable');
    expect(view!.passed).toBe(false);
  });

  it('preserves the submitted text verbatim (no normalization of the displayed value)', () => {
    const view = buildResultView(REPORTED_EVAL, '  The Trip WAS memorable  ', 'item-1', 'item-1');
    expect(view!.submittedAnswer).toBe('  The Trip WAS memorable  ');
  });

  it('a correct submission shows the same submitted text and passed=true', () => {
    const evalPass: ErrorReviewEvaluation = { ...REPORTED_EVAL, passed: true, mastered: false };
    const view = buildResultView(evalPass, 'that trip was memorable', 'item-1', 'item-1');
    expect(view!.passed).toBe(true);
    expect(view!.submittedAnswer).toBe('that trip was memorable');
  });
});

describe('buildResultView — attempt isolation (no reuse of a previous answer)', () => {
  it('attempt 2 shows attempt 2 answer, never attempt 1', () => {
    const a1 = buildResultView(REPORTED_EVAL, 'that trip had memorable', 'item-1', 'item-1');
    const a2 = buildResultView(REPORTED_EVAL, 'the trip was memorable', 'item-1', 'item-1');
    expect(a1!.submittedAnswer).toBe('that trip had memorable');
    expect(a2!.submittedAnswer).toBe('the trip was memorable');
    // Building the second view never carries the first answer.
    expect(a2!.submittedAnswer).not.toBe(a1!.submittedAnswer);
  });

  it('two consecutive different items each bind to their own answer', () => {
    const v1 = buildResultView(REPORTED_EVAL, 'answer one', 'item-1', 'item-1');
    const v2 = buildResultView({ ...REPORTED_EVAL, originalValue: 'x', correctedValue: 'y' }, 'answer two', 'item-2', 'item-2');
    expect(v1!.itemId).toBe('item-1');
    expect(v1!.submittedAnswer).toBe('answer one');
    expect(v2!.itemId).toBe('item-2');
    expect(v2!.submittedAnswer).toBe('answer two');
  });
});

describe('buildResultView — stale / out-of-order responses are dropped', () => {
  it('drops a response for a card the user already left (out-of-order A/B)', () => {
    // Request A submitted for item-1, but by the time it resolves the current
    // card is item-2 → the late A response must NOT overwrite item-2's feedback.
    const stale = buildResultView(REPORTED_EVAL, 'answer for A', 'item-1', 'item-2');
    expect(stale).toBeNull();
  });

  it('drops a response when there is no current item (user navigated away)', () => {
    expect(buildResultView(REPORTED_EVAL, 'x', 'item-1', undefined)).toBeNull();
    expect(buildResultView(REPORTED_EVAL, 'x', 'item-1', null)).toBeNull();
  });

  it('retry of the same item+answer yields the same submitted answer (idempotent display)', () => {
    const first = buildResultView(REPORTED_EVAL, 'the trip was memorable', 'item-1', 'item-1');
    const retry = buildResultView(REPORTED_EVAL, 'the trip was memorable', 'item-1', 'item-1');
    expect(retry!.submittedAnswer).toBe(first!.submittedAnswer);
  });
});
