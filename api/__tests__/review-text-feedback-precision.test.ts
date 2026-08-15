import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Item 4: the per-error feedback (mainMistakes.explanation) is produced by the
 * AI, so it cannot be asserted deterministically. Instead we guard the PROMPT
 * guidance that steers the model toward precise, non-generic explanations — in
 * particular the auxiliary-agreement rule ("doesn't likes" -> "doesn't like")
 * and the protection of correct contractions.
 *
 * DATA-DRIVEN REFRACTOR: these precision rules used to live in the hardcoded
 * MAIN_MISTAKES_PRECISION_RULES constant inside api/review-text.ts, injected
 * into the normal and review system prompts. That constant was removed when the
 * correction prompts moved into the DB curriculum engine. The rules now live in
 * the seeded prompt templates (writing.correct and writing.correct_review) in
 * migration 20260815120300_seed_prompt_templates_writing_feedback.sql — the new
 * source of truth. This test guards them there: a regression that drops the
 * guidance from either seeded template fails this test.
 */
const seedSql = readFileSync(
  fileURLToPath(
    new URL(
      '../../supabase/migrations/20260815120300_seed_prompt_templates_writing_feedback.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

describe('writing-feedback prompt precision guidance (seeded DB templates)', () => {
  it('seeds both the normal and review correction templates', () => {
    expect(seedSql).toContain("'writing.correct'");
    expect(seedSql).toContain("'writing.correct_review'");
  });

  it('explains the auxiliary base-form rule with the doesn\'t like example', () => {
    expect(seedSql).toContain('FORMA BASE');
    expect(seedSql).toContain("doesn't like");
    expect(seedSql).toContain("doesn't likes");
  });

  it('protects correct contractions from being flagged as errors', () => {
    expect(seedSql).toMatch(/NUNCA trate uma contração correta como erro/i);
  });

  it('includes the auxiliary FORMA BASE rule in BOTH the normal and review templates', () => {
    const matches = seedSql.match(/volta à FORMA BASE/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('includes the contraction-protection rule in BOTH the normal and review templates', () => {
    const matches = seedSql.match(/NUNCA trate uma contração correta como erro/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
