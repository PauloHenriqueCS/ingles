/**
 * Static security assertions on
 * supabase/migrations/20260722200000_enable_rls_listening_bookmark_word_timings.sql.
 *
 * This repo's Vitest suite is entirely mock-based (no local Postgres), so it
 * cannot exercise real RLS. What it CAN prove, from the SQL text itself
 * (same precedent as api/__tests__/ai-gateway-migration-security.test.ts),
 * is that the migration shipped the intended, minimal-privilege shape:
 * RLS enabled, service_role allowed, authenticated explicitly denied (never
 * USING (true)/WITH CHECK (true) for it), and the raw anon/authenticated/
 * PUBLIC grants revoked. Real RLS/grant enforcement against the live
 * database is proven separately in
 * supabase/manual-validation/listening-bookmark-word-timings-rls.sql —
 * genuine role-switching behavior requires a live Postgres, never faked
 * here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATION_PATH = resolve(
  __dirname, '..', '20260722200000_enable_rls_listening_bookmark_word_timings.sql',
);
const sql = readFileSync(MIGRATION_PATH, 'utf8');

const TABLES = ['listening_bookmark_timings', 'listening_word_timings'] as const;

describe('20260722200000_enable_rls_listening_bookmark_word_timings — no CREATE/ALTER of unrelated objects', () => {
  it('never creates, drops, or alters a table other than the two targets', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+(?!public\.listening_bookmark_timings|public\.listening_word_timings)/i);
  });

  it('never issues DDL/DML against writing-rewrite, missions, or story-generation tables (mentioning them in explanatory comments is fine)', () => {
    // Strip SQL line comments first — the header prose legitimately mentions
    // listening_audio_assets/listening_episodes/listening_blocks (documenting
    // the FK ownership chain) and the word "GRANT" in plain Portuguese
    // ("GRANT padrão do Supabase"), which must never be misread as executable
    // statements against those tables.
    const codeOnly = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    const UNRELATED_TABLES = [
      'writing_rewrite_attempts', 'writing_missions', 'listening_episodes',
      'listening_blocks', 'listening_audio_assets', 'listening_jobs',
    ];
    for (const table of UNRELATED_TABLES) {
      expect(codeOnly).not.toMatch(new RegExp(`(CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE POLICY|REVOKE|GRANT)[^;]*\\b${table}\\b`, 'i'));
    }
  });
});

describe.each(TABLES)('%s — RLS enabled, minimal-privilege policies, no raw grants', (table) => {
  it('RLS is enabled', () => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  });

  it('service_role gets a FOR ALL policy (backend writes/reads still work)', () => {
    expect(sql).toMatch(new RegExp(`CREATE POLICY[^;]*ON public\\.${table}\\s+FOR ALL TO service_role USING \\(true\\) WITH CHECK \\(true\\)`, 's'));
  });

  it('authenticated is explicitly denied — never USING (true) for authenticated', () => {
    const authPolicyMatch = sql.match(new RegExp(`CREATE POLICY[^;]*ON public\\.${table}\\s+FOR ALL TO authenticated USING \\(([^)]*)\\)`, 's'));
    expect(authPolicyMatch).not.toBeNull();
    expect(authPolicyMatch![1].trim()).toBe('false');
  });

  it('no policy for this table ever uses the permissive USING (true)/WITH CHECK (true) shape for anon or authenticated', () => {
    // Isolate this table's own policy block(s) so an unrelated service_role
    // "USING (true)" match on another table can never produce a false pass.
    const blockRe = new RegExp(`-- BLOCO \\d: ${table}[\\s\\S]*?(?=-- BLOCO|VALIDA[CÇ][ÃA]O)`, 'i');
    const block = sql.match(blockRe)?.[0] ?? '';
    expect(block).not.toMatch(/TO anon[^;]*USING \(true\)/is);
    expect(block).not.toMatch(/TO authenticated[^;]*USING \(true\)/is);
  });

  it('raw grants are revoked from anon, authenticated, and PUBLIC', () => {
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM anon;`);
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM authenticated;`);
    expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC;`);
  });

  it('service_role and postgres are never revoked from (backend access preserved)', () => {
    expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON public\\.${table} FROM service_role`));
    expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON public\\.${table} FROM postgres`));
  });
});

describe('inline validation block', () => {
  it('asserts RLS is enabled on both tables before COMMIT', () => {
    expect(sql).toMatch(/relrowsecurity INTO v_rls_lbt FROM pg_class WHERE oid = 'public\.listening_bookmark_timings'::regclass/);
    expect(sql).toMatch(/relrowsecurity INTO v_rls_lwt FROM pg_class WHERE oid = 'public\.listening_word_timings'::regclass/);
    expect(sql).toMatch(/IF NOT v_rls_lbt OR NOT v_rls_lwt THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it('asserts anon/authenticated hold zero privileges on both tables before COMMIT', () => {
    expect(sql).toMatch(/IF v_anon_lbt OR v_auth_lbt OR v_anon_lwt OR v_auth_lwt THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it('asserts exactly 2 policies exist per table (no accidental extra permissive policy)', () => {
    expect(sql).toMatch(/IF v_policy_count_lbt <> 2 OR v_policy_count_lwt <> 2 THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it('the whole migration runs inside an explicit transaction (BEGIN...COMMIT)', () => {
    expect(sql.trim().startsWith('-- =')).toBe(true);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('COMMIT;'));
  });
});
