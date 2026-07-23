/**
 * Static source assertions on src/components/RewriteSection.tsx.
 *
 * This repo has no DOM/component test harness (vite.config.ts's vitest
 * environment is 'node', no @testing-library/react) — the established
 * precedent for proving architectural wiring without rendering is a static
 * source-text assertion (see api/__tests__/ai-gateway-preflight-script-static.test.ts).
 * That is what's used here to prove: the frontend's primary rewrite-evaluation
 * path calls the canonical endpoint (not the legacy one), there is exactly
 * one evaluation call site (no parallel/duplicate direct call), and the
 * separate "generate final corrected text" feature is untouched — it is a
 * different feature (writing.correct_v2_text), not a second evaluation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC_PATH = resolve(__dirname, '..', 'RewriteSection.tsx');
const src = readFileSync(SRC_PATH, 'utf8');

function extractFunctionBody(fnName: string): string {
  const start = src.indexOf(`function ${fnName}(`);
  expect(start, `function ${fnName} not found`).toBeGreaterThan(-1);
  // Balance braces from the first '{' after the signature to find the matching close.
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for function ${fnName}`);
}

describe('RewriteSection.tsx — primary evaluation path calls the canonical endpoint', () => {
  it('compare() calls /api/writing-rewrite-evaluate', () => {
    const compareBody = extractFunctionBody('compare');
    expect(compareBody).toMatch(/fetch\(apiUrl\('\/api\/writing-rewrite-evaluate'\)/);
  });

  it('compare() does NOT call the legacy /api/compare-rewrite endpoint directly', () => {
    const compareBody = extractFunctionBody('compare');
    expect(compareBody).not.toMatch(/fetch\(apiUrl\('\/api\/compare-rewrite'\)/);
  });

  it('compare() contains exactly one fetch(...) call to an evaluation endpoint (no duplicate/parallel evaluation call)', () => {
    const compareBody = extractFunctionBody('compare');
    const evaluationFetchCalls = compareBody.match(/fetch\(apiUrl\('\/api\/writing-rewrite-evaluate'\)/g) ?? [];
    expect(evaluationFetchCalls).toHaveLength(1);
    // generateFinalText() is invoked (a separate feature, writing.correct_v2_text,
    // not a second evaluation), never a second writing-rewrite-evaluate call.
    expect(compareBody).toMatch(/generateFinalText\(trimmedRewrite\)/);
  });

  it('the canonical endpoint response is mapped through the adapter before being displayed — never rendered raw', () => {
    const compareBody = extractFunctionBody('compare');
    expect(compareBody).toMatch(/mapRewriteEvaluationToComparisonResult\(dto\)/);
  });

  it('a missing reviewId is a visible error state, never a silent no-op or a fallback to the legacy endpoint', () => {
    const compareBody = extractFunctionBody('compare');
    expect(compareBody).toMatch(/if \(!reviewId\)/);
    expect(compareBody).toMatch(/setCompareState\('error'\)/);
  });

  it('generateFinalText() (the separate final-text feature) still exists and is untouched, using its own endpoint', () => {
    const finalTextBody = extractFunctionBody('generateFinalText');
    expect(finalTextBody).toMatch(/fetch\(apiUrl\('\/api\/compare-rewrite'\)/);
    expect(finalTextBody).toMatch(/generateFinalTextOnly: true/);
  });

  it('the file imports the adapter and the canonical DTO type', () => {
    expect(src).toMatch(/import \{ mapRewriteEvaluationToComparisonResult \} from '\.\.\/lib\/rewriteComparisonAdapter'/);
    expect(src).toMatch(/import type \{ PublicWritingRewriteDTO \} from '\.\.\/domain\/writing-rewrite\/rewrite-public-dto'/);
  });

  it('reviewId is destructured from props (previously declared but unused — a prerequisite bug fix for this wiring)', () => {
    const propsDestructureStart = src.indexOf('export default function RewriteSection({');
    const propsDestructureEnd = src.indexOf('}: Props)', propsDestructureStart);
    const destructure = src.slice(propsDestructureStart, propsDestructureEnd);
    expect(destructure).toMatch(/\breviewId\b/);
  });
});

describe('RewriteSection.tsx — bug fix: generateFinalText() must never fire after a failed/rejected evaluation', () => {
  it('compare() validates content before calling the evaluation endpoint, and rejects without fetching', () => {
    const compareBody = extractFunctionBody('compare');
    expect(compareBody).toMatch(/validateRewriteText\(trimmedRewrite\)/);
    // The validation check must appear before the fetch call, not after.
    const validateIdx = compareBody.indexOf('validateRewriteText(trimmedRewrite)');
    const fetchIdx = compareBody.indexOf(`fetch(apiUrl('/api/writing-rewrite-evaluate')`);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeLessThan(fetchIdx);
  });

  it('the file imports validateRewriteText from the shared domain validation module', () => {
    expect(src).toMatch(/import \{ validateRewriteText \} from '\.\.\/domain\/writing-rewrite\/rewrite-text-validation'/);
  });

  it('generateFinalText(trimmedRewrite) is only reachable after setCompareState(\'done\') — never called unconditionally after the try/catch', () => {
    const compareBody = extractFunctionBody('compare');
    const doneIdx = compareBody.indexOf(`setCompareState('done')`);
    const genIdx = compareBody.indexOf('generateFinalText(trimmedRewrite)');
    const catchIdx = compareBody.indexOf('} catch (err) {');
    expect(doneIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(-1);
    // generateFinalText must be called strictly between the success marker
    // and the catch block — i.e. inside the try's success path — not after
    // the whole try/catch statement (which is what caused the original bug:
    // both "comparison failed" and "final text failed" appearing together).
    expect(genIdx).toBeGreaterThan(doneIdx);
    expect(genIdx).toBeLessThan(catchIdx);
  });

  it('a failed HTTP response returns before reaching generateFinalText (early return on !res.ok)', () => {
    const compareBody = extractFunctionBody('compare');
    const notOkIdx = compareBody.indexOf('if (!res.ok)');
    const returnAfterNotOk = compareBody.indexOf('return;', notOkIdx);
    const genIdx = compareBody.indexOf('generateFinalText(trimmedRewrite)');
    expect(notOkIdx).toBeGreaterThan(-1);
    expect(returnAfterNotOk).toBeGreaterThan(notOkIdx);
    expect(returnAfterNotOk).toBeLessThan(genIdx);
  });

  it('compare() and generateFinalText() surface the backend-provided message instead of a hardcoded generic string', () => {
    const compareBody = extractFunctionBody('compare');
    const finalTextBody = extractFunctionBody('generateFinalText');
    expect(compareBody).toMatch(/data\?\.message/);
    expect(finalTextBody).toMatch(/data\?\.message/);
  });
});
