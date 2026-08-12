/**
 * Static SQL-text assertions for
 * 20260812180000_listening_shared_stories_multi_slot.sql — no live DB.
 * The migration must allow multiple shared stories per (level_group,
 * practice_date) via a slot, and make the acquire RPC user-aware (returns the
 * next story the user hasn't opened) with race-free slot allocation. The daily
 * limit itself is NOT duplicated in SQL (stays in the handler).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260812180000_listening_shared_stories_multi_slot.sql'),
  'utf8',
);
const executableSql = sql
  .split('\n')
  .map((line) => (line.trim().startsWith('--') ? '' : line))
  .join('\n');

describe('20260812180000 — listening shared stories multi-slot', () => {
  it('adds a slot column and swaps the group/date unique key for group/date/slot', () => {
    expect(executableSql).toMatch(/ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 1/);
    expect(executableSql).toMatch(/DROP CONSTRAINT IF EXISTS uq_lss_group_date\b/);
    expect(executableSql).toMatch(/uq_lss_group_date_slot UNIQUE \(level_group, practice_date, slot\)/);
  });

  it('makes the acquire RPC user-aware and selects a story the user has NOT opened', () => {
    expect(executableSql).toMatch(/acquire_or_get_listening_shared_story\(\s*p_user_id\s+uuid/);
    expect(executableSql).toMatch(/NOT EXISTS \(SELECT 1 FROM user_listening_shared_progress p\s+WHERE p\.user_id = p_user_id AND p\.shared_story_id = s\.id\)/);
  });

  it('serializes slot allocation with an advisory lock and allocates MAX(slot)+1', () => {
    expect(executableSql).toMatch(/pg_advisory_xact_lock\(hashtextextended\(/);
    expect(executableSql).toMatch(/COALESCE\(MAX\(slot\), 0\) \+ 1/);
  });

  it('reuses cache first (ready, then dead slots, then a live in-flight generation) before allocating a new one', () => {
    expect(executableSql).toMatch(/s\.status = 'ready'/);
    expect(executableSql).toMatch(/s\.status = 'failed' OR \(s\.status = 'generating' AND s\.lock_expires_at < now\(\)\)/);
    expect(executableSql).toMatch(/s\.status = 'generating' AND s\.lock_expires_at >= now\(\)/);
  });

  it('does NOT duplicate the commercial daily limit inside the RPC (no plan-limit compare in SQL)', () => {
    expect(executableSql).not.toMatch(/p_effective_limit/);
    expect(executableSql).not.toMatch(/stories_per_day/);
  });

  it('drops the old 4-arg signature and preserves SECURITY DEFINER + service_role-only grant', () => {
    expect(executableSql).toMatch(/DROP FUNCTION IF EXISTS public\.acquire_or_get_listening_shared_story\(text, text, date, integer\)/);
    expect(executableSql).toMatch(/SECURITY DEFINER/);
    expect(executableSql).toMatch(/SET search_path = public/);
    expect(executableSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.acquire_or_get_listening_shared_story\(uuid, text, text, date, integer\) TO service_role/);
    expect(executableSql).not.toMatch(/GRANT EXECUTE[^;]*acquire_or_get_listening_shared_story[^;]*TO authenticated/);
  });

  it('is additive/non-destructive and never references the old app name', () => {
    expect(executableSql).not.toMatch(/\bDELETE FROM\b/i);
    expect(executableSql).not.toMatch(/\bDROP TABLE\b/i);
    expect(executableSql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/Lemon/);
  });
});
