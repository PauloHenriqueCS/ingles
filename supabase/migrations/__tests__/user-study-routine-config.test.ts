/**
 * Static checks for the mandatory study-routine config persistence migration: a
 * per-user table with the two-state status, RLS + explicit grants (repo
 * convention for a new user-owned table), and — critically — the ROLLOUT backfill
 * that grandfathers existing users so they are NEVER forced to reconfigure (§4),
 * done idempotently (ON CONFLICT DO NOTHING).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '..', '20260831120000_user_study_routine_config.sql'),
  'utf8',
);

describe('20260831120000 — user_study_routine_config', () => {
  it('creates one row per user (user_id PK → auth.users, cascade)', () => {
    expect(sql).toMatch(/create table if not exists public\.user_study_routine_config/i);
    expect(sql).toMatch(/user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/i);
  });

  it('models the two semantic states + timestamp', () => {
    expect(sql).toMatch(/status\s+text not null default 'unconfigured'/i);
    expect(sql).toMatch(/check \(status in \('unconfigured', 'configured'\)\)/i);
    expect(sql).toMatch(/configured_at timestamptz/i);
  });

  it('locks the row to its owner via RLS + explicit grants', () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/create policy usrc_all_own[\s\S]*using \(\(select auth\.uid\(\)\) = user_id\)/i);
    expect(sql).toMatch(/revoke all on public\.user_study_routine_config from anon/i);
    expect(sql).toMatch(/grant select, insert, update, delete on public\.user_study_routine_config to authenticated/i);
  });

  it('grandfathers existing users to configured so they are NOT force-shown the setup (§4)', () => {
    expect(sql).toMatch(/insert into public\.user_study_routine_config \(user_id, status, configured_at\)/i);
    expect(sql).toMatch(/select u\.id, 'configured', now\(\)\s*from auth\.users u/i);
  });

  it('makes the backfill idempotent (safe to re-run, never clobbers a real status)', () => {
    expect(sql).toMatch(/on conflict \(user_id\) do nothing/i);
  });

  it('keeps updated_at coherent with the shared trigger function', () => {
    expect(sql).toMatch(/execute function public\.set_updated_at\(\)/i);
  });

  it('does NOT duplicate the actual config values as columns (single source of truth)', () => {
    // The flag table stores only status + configured_at; the days and practice
    // toggles stay in user_learning_settings / user_curriculum_preferences
    // (§5/§9). The CREATE TABLE column list must not redefine those columns
    // (the doc-comment may mention the source tables — that's fine).
    const createBlock = sql.slice(
      sql.search(/create table if not exists public\.user_study_routine_config/i),
      sql.search(/COMMENT ON TABLE/i),
    );
    expect(createBlock).not.toMatch(/active_weekdays|practice_writing|practice_listening|practice_pronunciation|practice_conversation/i);
  });
});
