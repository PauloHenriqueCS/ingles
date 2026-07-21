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
    expect(compareBody).toMatch(/fetch\('\/api\/writing-rewrite-evaluate'/);
  });

  it('compare() does NOT call the legacy /api/compare-rewrite endpoint directly', () => {
    const compareBody = extractFunctionBody('compare');
    expect(compareBody).not.toMatch(/fetch\('\/api\/compare-rewrite'/);
  });

  it('compare() contains exactly one fetch(...) call to an evaluation endpoint (no duplicate/parallel evaluation call)', () => {
    const compareBody = extractFunctionBody('compare');
    const evaluationFetchCalls = compareBody.match(/fetch\('\/api\/writing-rewrite-evaluate'/g) ?? [];
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
    expect(finalTextBody).toMatch(/fetch\('\/api\/compare-rewrite'/);
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
