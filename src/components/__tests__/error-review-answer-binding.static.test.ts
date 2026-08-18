/**
 * Regression guard for the "Revisar meus erros" bug: the feedback used to render
 * the ORIGINAL error (result.originalValue) under the label "Sua resposta",
 * showing a phrase the student never submitted. These static source assertions
 * (node env, no DOM) lock in that "Sua resposta" is bound to the authoritative
 * submitted answer and that stale/out-of-order responses are dropped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const view = readFileSync(join(__dirname, '..', 'ErrorReviewView.tsx'), 'utf8');

describe('ErrorReviewView — "Sua resposta" binds to the submitted answer', () => {
  it('renders result.submittedAnswer under "Sua resposta", never result.originalValue', () => {
    const idx = view.indexOf('Sua resposta');
    expect(idx).toBeGreaterThan(-1);
    const around = view.slice(idx, idx + 320);
    expect(around).toMatch(/result\.submittedAnswer/);
    expect(around).not.toMatch(/result\.originalValue/);
  });

  it('snapshots the exact submitted answer + item id BEFORE awaiting the RPC', () => {
    expect(view).toMatch(/const submittedAnswer = answer/);
    expect(view).toMatch(/const submittedItemId = current\.id/);
    // The RPC is called with that snapshot, not with live state read after await.
    expect(view).toMatch(/submitErrorReviewItem\(submittedItemId, submittedAnswer\)/);
  });

  it('drops stale / out-of-order responses via buildResultView + the live item ref', () => {
    expect(view).toMatch(/buildResultView\(/);
    expect(view).toMatch(/currentItemIdRef\.current/);
  });
});
