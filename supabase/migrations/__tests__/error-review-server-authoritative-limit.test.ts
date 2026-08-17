/**
 * Static SQL-text assertions for
 * 20260817140000_error_review_server_authoritative_limit.sql — no live DB.
 *
 * Locks in the two hardening properties:
 *   1) the daily limit is server-authoritative — effective limit is
 *      LEAST(COALESCE(p_daily_limit,10), 10) with floor 0, so a client passing
 *      p_daily_limit=100 (or negative, or null) can never exceed 10;
 *   2) the "day" is server-authoritative in America/Sao_Paulo — counting and the
 *      stored activity_date derive from (now() AT TIME ZONE 'America/Sao_Paulo'),
 *      never from the client-supplied p_activity_date.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260817140000_error_review_server_authoritative_limit.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260817140000 — error review server-authoritative limit', () => {
  it('replaces both RPCs in place (same signatures, no DROP/no grant change needed)', () => {
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_error_review_session\(\s*p_activity_date date,\s*p_daily_limit\s+integer\s*\)/);
    expect(executableSql).toMatch(/CREATE OR REPLACE FUNCTION public\.submit_error_review_item\(\s*p_item_id\s+uuid,\s*p_submitted_text text,\s*p_activity_date\s+date,\s*p_daily_limit\s+integer\s*\)/);
    expect(executableSql).not.toMatch(/DROP FUNCTION/i);
  });

  it('the effective daily limit is hard-capped at 10 server-side (LEAST … 10, floor 0)', () => {
    // Appears in BOTH functions.
    const matches = executableSql.match(/greatest\(0, least\(COALESCE\(p_daily_limit, 10\), 10\)\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // The gate compares consumed against the capped v_limit, never the raw param.
    expect(executableSql).toMatch(/v_consumed >= v_limit/);
    expect(executableSql).not.toMatch(/v_consumed >= COALESCE\(p_daily_limit/);
    expect(executableSql).not.toMatch(/v_consumed >= p_daily_limit/);
  });

  it('the day is server-authoritative in America/Sao_Paulo (never the client date)', () => {
    const matches = executableSql.match(/\(now\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // Counting uses the server day, not the client-supplied p_activity_date.
    expect(executableSql).toMatch(/WHERE user_id = v_user AND activity_date = v_day/);
    expect(executableSql).not.toMatch(/activity_date = p_activity_date/);
    // The stored attempt row records the server day, not the client one.
    expect(executableSql).toMatch(/review_level_after, activity_date\s*\)\s*VALUES\s*\([\s\S]*?v_day\s*\)/);
  });

  it('keeps the per-user advisory lock so concurrent submits cannot exceed the cap', () => {
    expect(executableSql).toMatch(/pg_advisory_xact_lock\(hashtext\(v_user::text \|\| ':error_review'\)\)/);
  });

  it('preserves the approved 1/7/30/120 → mastered scheduler (unchanged)', () => {
    expect(executableSql).toMatch(/CASE v_new_lvl WHEN 1 THEN 7 WHEN 2 THEN 30 WHEN 3 THEN 120 END/);
    expect(executableSql).toMatch(/v_new_status := 'mastered'/);
    expect(executableSql).toMatch(/v_new_next := now\(\) \+ interval '1 day'/);
  });
});
