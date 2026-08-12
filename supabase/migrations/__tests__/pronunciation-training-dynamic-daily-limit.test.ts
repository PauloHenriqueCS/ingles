/**
 * Static SQL-text assertions for
 * 20260812170000_pronunciation_training_dynamic_daily_limit.sql — no live DB.
 * The migration must remove the 1/day architectural cap and make the limit
 * dynamic (passed in as p_effective_limit / p_unlimited), never hardcoded.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260812170000_pronunciation_training_dynamic_daily_limit.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260812170000 — pronunciation training dynamic daily limit', () => {
  it('replaces the one-row-per-day unique constraint with a partial "one active row" unique index', () => {
    expect(executableSql).toMatch(/DROP CONSTRAINT IF EXISTS uq_pts_user_date/);
    expect(executableSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_pts_active_per_day\s+ON public\.pronunciation_training_sessions \(user_id, practice_date\)\s+WHERE status <> 'completed'/);
  });

  it('reserve + create take the dynamic limit as parameters (never a hardcoded number)', () => {
    expect(executableSql).toMatch(/reserve_pronunciation_training_assessment\([^)]*p_effective_limit\s+integer[^)]*p_unlimited\s+boolean/s);
    expect(executableSql).toMatch(/create_pronunciation_training_text\([^)]*p_effective_limit\s+integer[^)]*p_unlimited\s+boolean/s);
    // Gate compares consumed against the passed-in limit, honoring unlimited.
    expect(executableSql).toMatch(/NOT COALESCE\(p_unlimited, false\) AND v_consumed >= COALESCE\(p_effective_limit/);
    // No hardcoded commercial number drives the daily gate.
    expect(executableSql).not.toMatch(/>=\s*[1-9]\d*\s*THEN/);
    expect(executableSql).not.toMatch(/v_consumed\s*>=\s*[0-9]+\b/);
  });

  it('counts reserved+completed as consumed so a held slot counts immediately', () => {
    expect(executableSql).toMatch(/status IN \('processing', 'completed'\)/);
  });

  it('drops the old function signatures and preserves SECURITY DEFINER + search_path', () => {
    expect(executableSql).toMatch(/DROP FUNCTION IF EXISTS public\.reserve_pronunciation_training_assessment\(date, text, uuid\)/);
    expect(executableSql).toMatch(/DROP FUNCTION IF EXISTS public\.create_pronunciation_training_text\(date, text, text, boolean\)/);
    expect((executableSql.match(/SECURITY DEFINER/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((executableSql.match(/SET search_path = public/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('re-grants EXECUTE to exactly the pre-existing roles (never broadens permissions)', () => {
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_pronunciation_training_assessment\(date, text, uuid, integer, boolean\) TO authenticated/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_pronunciation_training_assessment\(date, text, uuid, integer, boolean\) TO service_role/);
    expect(executableSql).toMatch(/REVOKE ALL ON FUNCTION public\.reserve_pronunciation_training_assessment\(date, text, uuid, integer, boolean\) FROM PUBLIC/);
  });

  it('contains no destructive statement and never references the old app name', () => {
    expect(executableSql).not.toMatch(/\bDELETE FROM\b/i);
    expect(executableSql).not.toMatch(/\bDROP TABLE\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/Lemon/);
  });
});
