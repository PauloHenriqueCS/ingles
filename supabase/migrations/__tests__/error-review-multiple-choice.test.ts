/**
 * Static SQL-text assertions for 20260903120000_error_review_multiple_choice.sql
 * (no live DB). Locks in the multiple-choice refactor: distractors on the prompt
 * + on the card (with a 3-element CHECK), the wipe of old errors that spares the
 * writing history, and a session RPC that serves 4 shuffled choices without ever
 * revealing which is correct — while leaving submit_error_review_item untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260903130000_error_review_multiple_choice.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260903120000 — error review multiple choice', () => {
  it('teaches the writing.correct prompt to emit 3 distractors, idempotently', () => {
    expect(executableSql).toMatch(/UPDATE public\.prompt_templates/);
    expect(executableSql).toMatch(/"distractors": \[string, string, string\]/);
    expect(executableSql).toMatch(/template_key = 'writing\.correct'/);
    // Guarded so re-running is a no-op (only when distractors not present yet).
    expect(executableSql).toMatch(/position\('"distractors"' in system_body\) = 0/);
  });

  it('adds review_group_items.distractors with a strict 3-element CHECK', () => {
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS distractors jsonb/);
    expect(executableSql).toMatch(/review_group_items_distractors_check/);
    expect(executableSql).toMatch(/jsonb_array_length\(distractors\) = 3/);
    expect(executableSql).toMatch(/distractors IS NOT NULL/);
  });

  it('wipes ALL old error-review rows child->parent', () => {
    for (const t of [
      'review_attempt_items',
      'review_schedule_history',
      'review_item_attempts',
      'review_attempts',
      'review_group_items',
      'review_groups',
    ]) {
      expect(executableSql).toMatch(new RegExp(`DELETE FROM public\\.${t};`));
    }
  });

  it('never deletes unrelated data (writing history / entries)', () => {
    expect(executableSql).not.toMatch(/DELETE FROM public\.english_reviews/i);
    expect(executableSql).not.toMatch(/DELETE FROM public\.writing_entries/i);
    expect(executableSql).not.toMatch(/DROP TABLE/i);
    expect(executableSql).not.toMatch(/TRUNCATE/i);
  });

  it('session RPC serves 4 shuffled choices = correctedValue + distractors', () => {
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_error_review_session\(/);
    // Build the option set from the correct value + the 3 stored distractors...
    expect(executableSql).toMatch(/jsonb_build_array\(rgi\.corrected_value\) \|\| rgi\.distractors/);
    // ...and shuffle server-side so the correct answer's position is not fixed.
    expect(executableSql).toMatch(/jsonb_agg\(c\.val ORDER BY random\(\)\)/);
    expect(executableSql).toMatch(/ch\.choices/);
  });

  it('session RPC never reveals which choice is correct', () => {
    const fn = executableSql.slice(executableSql.indexOf('get_error_review_session'));
    expect(fn).not.toMatch(/correctIndex/);
    expect(fn).not.toMatch(/correctOption/);
    expect(fn).not.toMatch(/"passed"/);
    expect(fn).not.toMatch(/isCorrect/);
  });

  it('preserves submit_error_review_item as the sole authority (not redefined here)', () => {
    expect(executableSql).not.toMatch(/FUNCTION public\.submit_error_review_item/);
  });

  it('keeps the daily-limit authority (São Paulo day, hard cap 10) in the session RPC', () => {
    expect(executableSql).toMatch(/least\(COALESCE\(p_daily_limit, 10\), 10\)/);
    expect(executableSql).toMatch(/America\/Sao_Paulo/);
  });

  it('re-grants execute only to authenticated and service_role', () => {
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_error_review_session\(date, integer\) TO authenticated/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_error_review_session\(date, integer\) TO service_role/);
  });
});
