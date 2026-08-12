/**
 * Static SQL-text assertions for
 * 20260812190000_listening_pending_vs_consumed.sql — no live DB.
 * Separates prepared (pending) from practiced (consumed) listening stories:
 * an activity_date column + a one-pending-per-day partial unique index, and an
 * atomic consume RPC. Must be additive/safe and must not backfill consumption.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260812190000_listening_pending_vs_consumed.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260812190000 — listening pending vs consumed', () => {
  it('adds a nullable activity_date column and backfills it from the shared story', () => {
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS activity_date date/);
    expect(executableSql).not.toMatch(/activity_date date NOT NULL/);
    expect(executableSql).toMatch(/UPDATE public\.user_listening_shared_progress p\s+SET activity_date = s\.practice_date/);
  });

  it('enforces ONE pending (completed=false) story per user per day via a partial unique index', () => {
    expect(executableSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_ulsp_one_pending_per_day\s+ON public\.user_listening_shared_progress \(user_id, activity_date\)\s+WHERE completed = false/);
  });

  it('the consume RPC flips completed=true atomically, is idempotent, and re-checks a dynamic limit', () => {
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.consume_listening_pending_story\(/);
    expect(executableSql).toMatch(/p_effective_limit integer/);
    expect(executableSql).toMatch(/p_unlimited\s+boolean/);
    expect(executableSql).toMatch(/FOR UPDATE/);
    // idempotent: an already-completed row returns already_consumed, no re-count.
    expect(executableSql).toMatch(/already_consumed/);
    // dynamic gate — no hardcoded commercial number.
    expect(executableSql).toMatch(/NOT COALESCE\(p_unlimited, false\) AND v_consumed >= COALESCE\(p_effective_limit/);
    expect(executableSql).toMatch(/SET completed\s*=\s*true/);
  });

  it('counts consumption only from completed=true rows (never from merely-prepared rows)', () => {
    expect(executableSql).toMatch(/count\(\*\)[\s\S]*?WHERE\s+user_id = v_user_id AND activity_date = p_practice_date AND completed = true/);
  });

  it('preserves SECURITY DEFINER + search_path and grants only authenticated/service_role', () => {
    expect(executableSql).toMatch(/SECURITY DEFINER/);
    expect(executableSql).toMatch(/SET search_path = public/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_listening_pending_story\(uuid, date, integer, boolean\) TO authenticated/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_listening_pending_story\(uuid, date, integer, boolean\) TO service_role/);
    expect(executableSql).toMatch(/REVOKE ALL ON FUNCTION public\.consume_listening_pending_story\(uuid, date, integer, boolean\) FROM PUBLIC/);
  });

  it('does NOT retroactively mark any historical row as consumed (backfill only sets activity_date)', () => {
    // The only backfill is UPDATE ... SET activity_date = s.practice_date ... FROM
    // listening_shared_stories. It must NOT touch `completed`. (The consume RPC's
    // own `SET completed = true` is a per-row runtime UPDATE guarded by
    // WHERE completed = false — not a backfill — so we scope this to the FROM-join
    // backfill statement only.)
    const backfill = executableSql.match(/UPDATE public\.user_listening_shared_progress[\s\S]*?FROM public\.listening_shared_stories[\s\S]*?;/);
    expect(backfill, 'backfill UPDATE not found').toBeTruthy();
    expect(backfill![0]).not.toMatch(/completed/);
    expect(executableSql).not.toMatch(/\bDELETE FROM\b/i);
    expect(executableSql).not.toMatch(/\bDROP TABLE\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('never references the old app name', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
