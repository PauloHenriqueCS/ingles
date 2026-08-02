/**
 * Static SQL-text assertions for
 * 20260802221500_conversation_minute_packages_grants.sql — no live database
 * connection here (same posture as the other migration static tests in this
 * repository).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '20260802221500_conversation_minute_packages_grants.sql'),
  'utf8',
);

describe('20260802221500 — conversation_minute_packages grants', () => {
  it('revokes ALL from PUBLIC and anon explicitly', () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.conversation_minute_packages FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON public\.conversation_minute_packages FROM anon;/);
  });

  it('grants authenticated exactly SELECT, INSERT, UPDATE — never DELETE', () => {
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.conversation_minute_packages TO authenticated;/);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO authenticated/);
  });

  it('grants service_role only SELECT — never INSERT, UPDATE, or DELETE', () => {
    expect(sql).toMatch(/GRANT SELECT ON public\.conversation_minute_packages TO service_role;/);
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO service_role/);
  });

  it('never grants anything to anon or PUBLIC', () => {
    expect(sql).not.toMatch(/GRANT[^;]*TO anon;/);
    expect(sql).not.toMatch(/GRANT[^;]*TO PUBLIC;/);
  });

  it('never creates, alters, drops, or renames a policy', () => {
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/DROP POLICY/i);
    expect(sql).not.toMatch(/ALTER POLICY/i);
  });

  it('never touches RLS enablement on the table', () => {
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
  });

  it('never grants EXECUTE on is_active_admin or can_manage_plans (already granted, confirmed not missing)', () => {
    expect(sql).not.toMatch(/GRANT EXECUTE/i);
  });

  it('never touches package data — no INSERT/UPDATE/DELETE against table rows, no draft/active status change', () => {
    expect(sql).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\.conversation_minute_packages\b/im);
    expect(sql).not.toMatch(/pacote-300-min|pacote-600-min|pacote-900-min/);
  });

  it('contains no destructive statement', () => {
    expect(sql).not.toMatch(/\bDROP TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('never references the old app name in new text', () => {
    expect(sql).not.toMatch(/Lemon/);
  });
});
