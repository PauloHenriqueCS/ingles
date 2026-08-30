/**
 * Static checks for the first-run tutorial persistence migration: a per-user
 * table with the three-state status, RLS + explicit grants (repo convention for
 * a new user-owned table), and — critically — the ROLLOUT backfill that
 * grandfathers existing users so they are NEVER forced into the tutorial (§8),
 * done idempotently (ON CONFLICT DO NOTHING).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '..', '20260830120000_user_tutorial_progress.sql'),
  'utf8',
);

describe('20260830120000 — user_tutorial_progress', () => {
  it('creates one row per user (user_id PK → auth.users, cascade)', () => {
    expect(sql).toMatch(/create table if not exists public\.user_tutorial_progress/i);
    expect(sql).toMatch(/user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/i);
  });

  it('models the three semantic states + timestamps (§8)', () => {
    expect(sql).toMatch(/status\s+text not null default 'pending'/i);
    expect(sql).toMatch(/check \(status in \('pending', 'completed', 'skipped'\)\)/i);
    expect(sql).toMatch(/completed_at timestamptz/i);
    expect(sql).toMatch(/skipped_at\s+timestamptz/i);
  });

  it('locks the row to its owner via RLS + explicit grants (§18)', () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/create policy utp_all_own[\s\S]*using \(\(select auth\.uid\(\)\) = user_id\)/i);
    expect(sql).toMatch(/revoke all on public\.user_tutorial_progress from anon/i);
    expect(sql).toMatch(/grant select, insert, update, delete on public\.user_tutorial_progress to authenticated/i);
  });

  it('grandfathers existing users to completed so they are NOT force-shown the tutorial (§8)', () => {
    expect(sql).toMatch(/insert into public\.user_tutorial_progress \(user_id, status, completed_at\)/i);
    expect(sql).toMatch(/select u\.id, 'completed', now\(\)\s*from auth\.users u/i);
  });

  it('makes the backfill idempotent (safe to re-run, never clobbers a real status)', () => {
    expect(sql).toMatch(/on conflict \(user_id\) do nothing/i);
  });

  it('keeps updated_at coherent with the shared trigger function', () => {
    expect(sql).toMatch(/execute function public\.set_updated_at\(\)/i);
  });
});
