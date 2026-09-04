/**
 * Static source guards for "Revisar meus erros" (múltipla escolha, node env, no
 * DOM). They lock in the multiple-choice contract:
 *   - the submitted answer is the EXACT selected choice text (never the original
 *     error, never a reconstructed value);
 *   - correctness is shown by comparing a choice to the backend's correctedValue,
 *     never by any client-side "isCorrect" flag arriving with the choices;
 *   - stale / out-of-order responses are dropped;
 *   - the old typing UI (textarea) is completely gone — no fallback.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const view = readFileSync(join(__dirname, '..', 'ErrorReviewView.tsx'), 'utf8');

describe('ErrorReviewView — multiple-choice answer binding', () => {
  it('submits the EXACT selected choice text, snapshotted before awaiting the RPC', () => {
    expect(view).toMatch(/const submittedAnswer = current\.choices\[selected\]/);
    expect(view).toMatch(/const submittedItemId = current\.id/);
    expect(view).toMatch(/submitErrorReviewItem\(submittedItemId, submittedAnswer\)/);
  });

  it('derives the correct choice from the backend correctedValue, not a client flag', () => {
    // The green "CORRETA" highlight compares each choice to result.correctedValue.
    expect(view).toMatch(/normalizeAnswer\(choice\) === correctNorm/);
    expect(view).toMatch(/normalizeAnswer\(result!\.correctedValue\)/);
    // The choices carry no correctness metadata — the item type is id/original/choices.
    expect(view).not.toMatch(/correctIndex/);
    expect(view).not.toMatch(/correctOption/);
  });

  it('drops stale / out-of-order responses via buildResultView + the live item ref', () => {
    expect(view).toMatch(/buildResultView\(/);
    expect(view).toMatch(/currentItemIdRef\.current/);
  });

  it('has NO textarea / typing fallback from the old model', () => {
    expect(view).not.toMatch(/<textarea/i);
    expect(view).not.toMatch(/Escreva a forma correta/);
  });

  it('blocks changing/answering while a submission is in flight (no double submit)', () => {
    // handleSelect ignores taps while submitting or after a result is shown.
    expect(view).toMatch(/if \(submitting \|\| result\) return;/);
    // handleVerify guards on submitting AND an already-present result.
    expect(view).toMatch(/selected === null \|\| submitting \|\| result/);
  });
});
