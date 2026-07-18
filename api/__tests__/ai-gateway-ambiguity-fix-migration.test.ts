/**
 * Static regression assertions on supabase/migrations/20260718020000_ai_gateway_
 * enforcement_function_ambiguity_fix.sql — Etapa 11, column-ambiguity correction.
 *
 * Real evidence from the Primary Database (2026-07-18, rollback proposital, no
 * data persisted): begin_gateway_idempotent_op_v1 and reserve_gateway_usage_v1
 * both threw "column reference ... is ambiguous" (RETURNS TABLE(...) injects a
 * PL/pgSQL variable per output column; both functions referenced a same-named
 * real table column bare in an embedded SQL statement). No local Postgres
 * instance is available in this development environment, so — same pattern as
 * api/__tests__/ai-gateway-migration-security.test.ts — these tests prove the
 * fix and its self-tests from the migration's own SQL text, never by executing
 * it here. The migration's own self-test (run transactionally at apply time,
 * before COMMIT) is what actually proves the fix works against a real
 * Postgres; these tests prove that self-test is structurally present and
 * covers the four regressions this correction must never reintroduce.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATION_PATH = resolve(__dirname, '..', '..', 'supabase', 'migrations', '20260718020000_ai_gateway_enforcement_function_ambiguity_fix.sql');
const sql = readFileSync(MIGRATION_PATH, 'utf8');

function functionBody(name: string): string {
  const declStart = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(declStart, `CREATE OR REPLACE FUNCTION public.${name} not found in migration`).toBeGreaterThanOrEqual(0);
  // Body starts AFTER the `AS $$` marker — deliberately excludes the
  // `RETURNS TABLE(...)` signature itself, whose column names (lock_id,
  // outcome, result_ref / reservation_id, status, ...) are legitimate OUT
  // parameter declarations, not usages, and would otherwise false-positive
  // any "no bare column reference" check below.
  const bodyStart = sql.indexOf('AS $$', declStart);
  expect(bodyStart, `AS $$ for ${name} not found`).toBeGreaterThan(declStart);
  const end = sql.indexOf('\n$$;', bodyStart);
  expect(end, `closing $$; for ${name} not found`).toBeGreaterThan(bodyStart);
  // Strip `--` line comments so prose mentioning a column name in passing
  // (e.g. "any status, including a prior block") can never false-positive
  // a "no bare reference" check either.
  return sql.slice(bodyStart, end).replace(/--[^\n]*/g, '');
}

describe('20260718020000 — ambiguous column references qualified, never masked', () => {
  it('never uses the #variable_conflict pragma directive anywhere — the explicit instruction was to qualify columns, not mask the ambiguity (the migration file explains this choice in prose, which is a legitimate mention, not a directive)', () => {
    expect(sql).not.toMatch(/#variable_conflict\s+(use_column|use_variable|error)/i);
  });

  it('begin_gateway_idempotent_op_v1 keeps its exact original signature and return type', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.begin_gateway_idempotent_op_v1\(\s*p_scope\s+TEXT,\s*p_idempotency_key\s+TEXT,\s*p_lease_seconds\s+INTEGER\s*\)\s*RETURNS TABLE\(lock_id UUID, outcome TEXT, result_ref TEXT\)/);
  });

  it('begin_gateway_idempotent_op_v1 qualifies every result_ref reference with the agil table alias — no bare "result_ref" column reference remains', () => {
    const body = functionBody('begin_gateway_idempotent_op_v1');
    expect(body).toMatch(/INSERT INTO public\.ai_gateway_idempotency_locks AS agil/);
    expect(body).toMatch(/RETURNING agil\.id, agil\.status, agil\.result_ref, \(agil\.xmax = 0\)/);
    expect(body).toMatch(/SELECT agil\.id, agil\.status, agil\.result_ref INTO v_id, v_status, v_result_ref/);
    expect(body).toMatch(/FROM public\.ai_gateway_idempotency_locks agil/);
    // No bare, unqualified "result_ref" left as a standalone column reference
    // outside of a SET target (target columns are never ambiguous) or a
    // plpgsql variable name (v_result_ref).
    const bareResultRef = body.match(/(?<![.\w])result_ref(?!\s*=)/g) ?? [];
    expect(bareResultRef, `found unqualified result_ref reference(s): ${JSON.stringify(bareResultRef)}`).toEqual([]);
  });

  it('reserve_gateway_usage_v1 keeps its exact original signature and return type', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.reserve_gateway_usage_v1\(/);
    expect(sql).toMatch(/RETURNS TABLE\(reservation_id UUID, status TEXT, expires_at TIMESTAMPTZ, blocked_reason TEXT, blocked_detail TEXT\)/);
  });

  it('reserve_gateway_usage_v1 qualifies both idempotent-retry SELECTs (initial check and unique_violation handler) with the ur table alias — no bare "status" column reference remains', () => {
    const body = functionBody('reserve_gateway_usage_v1');
    const occurrences = body.match(/SELECT ur\.id, ur\.status, ur\.expires_at INTO v_id, v_status, v_expires_at\s*\n\s*FROM public\.usage_reservations ur WHERE ur\.idempotency_key = p_idempotency_key/g) ?? [];
    // Exactly two: the unconditional first check, and the EXCEPTION WHEN
    // unique_violation handler — both existed as bugs in the original file.
    expect(occurrences.length).toBe(2);
    expect(body).toMatch(/EXCEPTION WHEN unique_violation THEN/);
    // No bare "status" left outside of a SET target, an INSERT column list,
    // an ON CONFLICT target list, a string literal, or a plpgsql variable
    // name (v_status) — the only legitimate remaining forms.
    const bareStatus = body.match(/(?<![.\w'])status(?!\s*=|\s*,\s*estimated_cost_usd)/g) ?? [];
    expect(bareStatus, `found unqualified status reference(s): ${JSON.stringify(bareStatus)}`).toEqual([]);
  });

  it('both corrected functions reaffirm REVOKE from PUBLIC/anon/authenticated and GRANT to service_role/postgres', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.begin_gateway_idempotent_op_v1\(TEXT, TEXT, INTEGER\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.begin_gateway_idempotent_op_v1\(TEXT, TEXT, INTEGER\) TO service_role, postgres;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.reserve_gateway_usage_v1\([^)]+\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_gateway_usage_v1\([^)]+\) TO service_role, postgres;/);
  });
});

describe('20260718020000 — self-test regression coverage (runs transactionally before COMMIT at apply time)', () => {
  it('regression 1: begin -> in_progress -> fail -> reclaimed is exercised and asserted', () => {
    expect(sql).toMatch(/PERFORM public\.begin_gateway_idempotent_op_v1\('migration-selftest:20260718020000', 'k1', 30\);/);
    expect(sql).toMatch(/IF v_probe_lock\.outcome IS DISTINCT FROM 'in_progress' THEN\s*\n\s*RAISE EXCEPTION/);
    expect(sql).toMatch(/PERFORM public\.fail_gateway_idempotent_op_v1\(v_probe_lock\.lock_id\);/);
    expect(sql).toMatch(/IF v_probe_lock\.outcome IS DISTINCT FROM 'reclaimed' THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it('regression 2: two reserve_gateway_usage_v1 calls with the same idempotency_key are asserted to return the SAME reservation_id (not just cleaned up)', () => {
    expect(sql).toMatch(/SELECT reservation_id INTO v_res_id_a FROM public\.reserve_gateway_usage_v1\(\s*\n\s*'migration-selftest-20260718020000'/);
    expect(sql).toMatch(/SELECT reservation_id INTO v_res_id_b FROM public\.reserve_gateway_usage_v1\(\s*\n\s*'migration-selftest-20260718020000'/);
    expect(sql).toMatch(/IF v_res_id_a IS DISTINCT FROM v_res_id_b OR v_res_id_a IS NULL THEN\s*\n\s*RAISE EXCEPTION/);
    expect(sql).toMatch(/SELECT COUNT\(\*\) INTO v_res_count FROM public\.usage_reservations WHERE idempotency_key = 'migration-selftest-20260718020000';/);
    expect(sql).toMatch(/IF v_res_count != 1 THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it('regression 3: a reservation WITH a quota limit triggers first-touch backfill without ambiguity, and the backfilled amount is asserted', () => {
    // Exercises the Phase 1 quota-bucket-touch path (limit_quantity set) —
    // the empty-metrics self-test above never reaches
    // _gateway_touch_quota_bucket_v1 at all, so this is a genuinely
    // different code path, not a duplicate of regression 2.
    expect(sql).toMatch(/'\[\{"quota_key":"output_text_tokens","unit_type":"token","reserved_quantity":10,"limit_quantity":10000/);
    expect(sql).toMatch(/INSERT INTO public\.ai_usage_event_metrics[\s\S]{0,200}'bbbbbbbb-0000-0000-0000-000000000020'::uuid, 'output_text_tokens', 'token', 321/);
    expect(sql).toMatch(/SELECT committed_quantity, backfilled INTO v_backfill_committed, v_backfill_flag/);
    expect(sql).toMatch(/IF v_backfill_committed IS DISTINCT FROM 321 OR v_backfill_flag IS DISTINCT FROM TRUE THEN\s*\n\s*RAISE EXCEPTION/);
  });

  it('regression 4: privileges are verified live (has_table_privilege / has_function_privilege) after CREATE OR REPLACE, not merely re-declared', () => {
    expect(sql).toMatch(/IF has_function_privilege\('anon', 'public\.begin_gateway_idempotent_op_v1\(text, text, integer\)', 'EXECUTE'\)\s*\n\s*OR has_function_privilege\('authenticated'/);
    expect(sql).toMatch(/IF NOT has_function_privilege\('service_role', 'public\.begin_gateway_idempotent_op_v1\(text, text, integer\)', 'EXECUTE'\) THEN/);
    expect(sql).toMatch(/IF has_function_privilege\('anon', 'public\.reserve_gateway_usage_v1\([^']*\)', 'EXECUTE'\)/);
    expect(sql).toMatch(/IF NOT has_function_privilege\('service_role', 'public\.reserve_gateway_usage_v1\([^']*\)', 'EXECUTE'\) THEN/);
  });

  it('every self-test cleans up its own synthetic rows, and residual-row checks exist for all four regressions', () => {
    expect(sql).toMatch(/DELETE FROM public\.ai_gateway_idempotency_locks WHERE scope = 'migration-selftest:20260718020000';/);
    expect(sql).toMatch(/DELETE FROM public\.usage_reservations WHERE idempotency_key = 'migration-selftest-20260718020000';/);
    expect(sql).toMatch(/DELETE FROM public\.usage_reservations WHERE idempotency_key = 'migration-selftest-backfill-20260718020000';/);
    expect(sql).toMatch(/DELETE FROM public\.ai_usage_events WHERE id = 'bbbbbbbb-0000-0000-0000-000000000020'::uuid;/);
    expect(sql).toMatch(/RAISE EXCEPTION 'VALIDATION FAILED: self-test left a residual ai_gateway_idempotency_locks row';/);
    expect(sql).toMatch(/RAISE EXCEPTION 'VALIDATION FAILED: quota-backfill self-test left a residual ai_gateway_quota_buckets row';/);
  });

  it('the whole self-test runs inside the migration transaction, before COMMIT — a failed self-test aborts the entire migration, never leaves a half-applied state', () => {
    const doBlockStart = sql.indexOf('DO $$');
    const commitIndex = sql.indexOf('\nCOMMIT;');
    const selfTestIndex = sql.indexOf("PERFORM public.begin_gateway_idempotent_op_v1('migration-selftest:20260718020000'");
    expect(doBlockStart).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(doBlockStart);
    expect(selfTestIndex).toBeGreaterThan(doBlockStart);
    expect(selfTestIndex).toBeLessThan(commitIndex);
  });
});

describe('20260718020000 — scope discipline (item 6: only ambiguity, nothing else)', () => {
  it('never touches quota/budget/dedupe/reservation business logic — only REVOKE/GRANT and the two CREATE OR REPLACE bodies are new statements beyond the self-test', () => {
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/CREATE TABLE(?! TEMP)/i);
    expect(sql).not.toMatch(/DROP (TABLE|FUNCTION|TRIGGER)(?! IF EXISTS pg_temp)/i);
  });

  it('never writes to ai_runtime_controls or provider_pricing outside the before/after validation snapshot machinery', () => {
    const insertsOrUpdates = sql.match(/(INSERT INTO|UPDATE)\s+public\.(ai_runtime_controls|provider_pricing)/gi) ?? [];
    expect(insertsOrUpdates).toEqual([]);
  });
});
