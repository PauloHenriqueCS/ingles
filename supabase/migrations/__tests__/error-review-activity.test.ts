/**
 * Static SQL-text assertions for 20260817120000_error_review_activity.sql —
 * no live DB. Locks in: per-item scheduler columns on review_group_items, the
 * per-item attempts table, the approved 1/7/30/120→mastered cycle, the
 * daily-limit gate (number passed as a parameter, never hardcoded), the
 * "open never consumes" contract, and the removal of the permissive legacy
 * english_reviews policies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260817120000_error_review_activity.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260817120000 — error review activity', () => {
  it('turns review_group_items into the per-item card entity (scheduler columns)', () => {
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS user_id\s+uuid/);
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS status\s+text NOT NULL DEFAULT 'scheduled'/);
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS review_level\s+integer NOT NULL DEFAULT 0/);
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS next_review_at timestamptz/);
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS mastered_at/);
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS reactivated_at/);
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS concept_key/);
  });

  it('status is constrained to scheduled|mastered', () => {
    expect(executableSql).toMatch(/CHECK \(status IN \('scheduled', 'mastered'\)\)/);
  });

  it('backfills existing items conservatively without deleting history', () => {
    expect(executableSql).toMatch(/UPDATE public\.review_group_items i\s+SET user_id = g\.user_id/);
    expect(executableSql).not.toMatch(/DELETE FROM public\.review_group/i);
    expect(executableSql).not.toMatch(/DROP TABLE/i);
  });

  it('a new captured error schedules its first review at +1 day', () => {
    expect(executableSql).toMatch(/NEW\.next_review_at := now\(\) \+ interval '1 day'/);
  });

  it('creates the per-item attempts table with RLS scoped to the owner', () => {
    expect(executableSql).toMatch(/CREATE TABLE IF NOT EXISTS public\.review_item_attempts/);
    expect(executableSql).toMatch(/activity_date\s+date NOT NULL/);
    expect(executableSql).toMatch(/CREATE POLICY "ria_select"[\s\S]*?USING \(auth\.uid\(\) = user_id\)/);
  });

  it('session RPC never consumes and hides the answer (no corrected_value/explanation in the returned items)', () => {
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_error_review_session\(/);
    // items expose only the student's own error text, never the correction.
    const sessionFn = executableSql.slice(executableSql.indexOf('get_error_review_session'));
    const sessionBody = sessionFn.slice(0, sessionFn.indexOf('submit_error_review_item'));
    expect(sessionBody).toMatch(/original_value\s+AS "originalValue"/);
    expect(sessionBody).not.toMatch(/corrected_value/);
    expect(sessionBody).not.toMatch(/INSERT INTO/);
  });

  it('submit RPC enforces the daily limit atomically (advisory lock + parameterized number)', () => {
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.submit_error_review_item\(/);
    expect(executableSql).toMatch(/pg_advisory_xact_lock/);
    expect(executableSql).toMatch(/v_consumed >= COALESCE\(p_daily_limit, 0\)/);
    expect(executableSql).toMatch(/DAILY_LIMIT_REACHED/);
    // no hardcoded commercial number in SQL
    expect(executableSql).not.toMatch(/v_consumed >= 10/);
  });

  it('submit RPC implements the approved 1/7/30/120 → mastered cycle', () => {
    expect(executableSql).toMatch(/CASE v_new_lvl WHEN 1 THEN 7 WHEN 2 THEN 30 WHEN 3 THEN 120 END/);
    expect(executableSql).toMatch(/v_prev_lvl >= 3/);
    expect(executableSql).toMatch(/v_new_status := 'mastered'/);
    // fail resets to level 0, +1 day (never the old 2/7/21/60 intervals)
    expect(executableSql).toMatch(/v_new_lvl := 0;[\s\S]*?v_new_next := now\(\) \+ interval '1 day'/);
    expect(executableSql).not.toMatch(/interval '21 days'/);
    expect(executableSql).not.toMatch(/interval '60 days'/);
  });

  it('submit RPC computes pass/fail deterministically and rejects keeping the error', () => {
    expect(executableSql).toMatch(/error_review_normalize/);
    expect(executableSql).toMatch(/v_passed := \(v_sub = v_cor\) AND \(v_cor = v_org OR v_sub <> v_org\)/);
  });

  it('grants execute only to authenticated and service_role', () => {
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.submit_error_review_item\(uuid, text, date, integer\) TO authenticated/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_error_review_session\(date, integer\) TO authenticated/);
  });

  it('removes the permissive legacy english_reviews policies (the OR user_id IS NULL leak)', () => {
    expect(executableSql).toMatch(/DROP POLICY IF EXISTS "Allow read english reviews"\s+ON public\.english_reviews/);
    expect(executableSql).toMatch(/DROP POLICY IF EXISTS "Allow insert english reviews"\s+ON public\.english_reviews/);
  });
});
