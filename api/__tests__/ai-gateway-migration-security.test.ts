/**
 * Static security assertions on supabase/migrations/20260718000000_ai_gateway_enforcement.sql's
 * BLOCO 8 (ai_gateway_concurrency_validations + record_gateway_concurrency_validation_v1) —
 * Etapa 11, Fase 16 — operational correction.
 *
 * This migration is NOT applied to any live database in this environment
 * (see supabase/manual-validation/ai-gateway-enforcement-concurrency.sql —
 * concurrency scenarios genuinely require a live database and are validated
 * there, never faked here). These tests instead prove, from the SQL text
 * itself, that a normal user or the frontend has no path to writing an
 * approval row: RLS enabled with zero CREATE POLICY statements for this
 * table, plus the one writer function REVOKEd from anon/authenticated.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATION_PATH = resolve(__dirname, '..', '..', 'supabase', 'migrations', '20260718000000_ai_gateway_enforcement.sql');
const sql = readFileSync(MIGRATION_PATH, 'utf8');

describe('ai_gateway_concurrency_validations — no frontend/ordinary-user write path', () => {
  it('the table is created', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ai_gateway_concurrency_validations/);
  });

  it('RLS is enabled on the table', () => {
    expect(sql).toMatch(/ALTER TABLE public\.ai_gateway_concurrency_validations ENABLE ROW LEVEL SECURITY/);
  });

  it('no CREATE POLICY statement ever targets this table — RLS enabled + zero policies means only service_role bypasses', () => {
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ai_gateway_concurrency_validations/is);
  });

  it('the only writer function is REVOKEd from PUBLIC, anon, and authenticated', () => {
    const sig = 'public.record_gateway_concurrency_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)';
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`);
  });

  it('the writer function validates the hash shape server-side (64-char lowercase hex) before any INSERT can occur', () => {
    const fnBody = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.record_gateway_concurrency_validation_v1'),
      sql.indexOf('$$;', sql.indexOf('CREATE OR REPLACE FUNCTION public.record_gateway_concurrency_validation_v1')),
    );
    expect(fnBody).toMatch(/RAISE EXCEPTION[^;]*validation_script_sha256/i);
    expect(fnBody.indexOf('RAISE EXCEPTION')).toBeLessThan(fnBody.indexOf('INSERT INTO'));
  });

  it('no UPDATE or DELETE function is provided for this table — append-only, a stale validation is superseded by a newer row, never edited in place', () => {
    expect(sql).not.toMatch(/UPDATE\s+public\.ai_gateway_concurrency_validations/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.ai_gateway_concurrency_validations/i);
  });

  it('the CHECK constraint enforces a 64-char lowercase hex digest at the column level too (defense in depth beyond the function-level RAISE EXCEPTION)', () => {
    expect(sql).toMatch(/validation_script_sha256\s+TEXT\s+NOT NULL CHECK \(validation_script_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  });

  it('the migration\'s final validation block counts this table and function among the expected post-migration objects (infraDeployed detection relies on both existing)', () => {
    expect(sql).toMatch(/'ai_gateway_concurrency_validations'/);
    expect(sql).toMatch(/'record_gateway_concurrency_validation_v1'/);
  });
});
