import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Item 4: the per-error feedback (mainMistakes.explanation) is produced by the
 * AI, so it cannot be asserted deterministically. Instead we guard the PROMPT
 * guidance that steers the model toward precise, non-generic explanations — in
 * particular the auxiliary-agreement rule ("doesn't likes" -> "doesn't like").
 * A regression that drops this guidance from either prompt fails this test.
 */
const source = readFileSync(
  fileURLToPath(new URL('../review-text.ts', import.meta.url)),
  'utf8',
);

describe('review-text mainMistakes precision guidance', () => {
  it('defines the shared precision rules constant', () => {
    expect(source).toContain('const MAIN_MISTAKES_PRECISION_RULES');
  });

  it('explains the auxiliary base-form rule with the doesn\'t like example', () => {
    expect(source).toContain('FORMA BASE');
    expect(source).toContain("doesn't like");
    expect(source).toContain("doesn't likes");
  });

  it('protects correct contractions from being flagged as errors', () => {
    expect(source).toMatch(/NUNCA trate uma contração correta como erro/i);
  });

  it('injects the precision rules into BOTH the normal and review prompts', () => {
    const matches = source.match(/\$\{MAIN_MISTAKES_PRECISION_RULES\}/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
