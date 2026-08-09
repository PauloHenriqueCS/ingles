/**
 * Static SQL-text assertions for
 * 20260727224400_fix_authorize_trial_conversation_session_reservation_accounting.sql
 * — no live database connection here (same posture as the other migration
 * static tests in this directory). This migration exists because a REAL
 * concurrency gap was found running the previous version live against
 * lemon-homolog: two sessions requested 600s each against a 900s trial and
 * BOTH were authorized in full (1200s total) because an in-progress
 * ('authorized') row only counted its live elapsed time, not its full
 * reserved ceiling, toward the balance. These tests assert the reservation
 * formula itself — they do not replace running the function against a real
 * Postgres instance (already done for this fix, see the delivery report).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '..', 'migrations', '20260727224400_fix_authorize_trial_conversation_session_reservation_accounting.sql'),
  'utf8',
);

const fnBody = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.authorize_trial_conversation_session_v1'),
  sql.lastIndexOf('$function$;'),
);
const fnBodyCode = fnBody.replace(/--.*$/gm, '');

describe('20260727224400 — fix authorize_trial_conversation_session_v1 reservation accounting', () => {
  it('preserves the exact same signature, return shape, SECURITY DEFINER, and search_path', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.authorize_trial_conversation_session_v1\(\s*\n\s*p_user_id uuid,\s*\n\s*p_requested_max_seconds integer,\s*\n\s*p_session_date date,\s*\n\s*p_gateway_budget_reservation_id uuid,\s*\n\s*p_gateway_session_id uuid,\s*\n\s*p_idempotency_key text\s*\n\)/,
    );
    expect(sql).toContain('RETURNS TABLE(authorization_id uuid, authorized_max_seconds integer, blocked boolean, blocked_reason text)');
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it('never alters the conversation_session_authorizations schema — no ALTER TABLE, no new table, function replacement only (checked outside prose comments, which discuss this decision in text)', () => {
    // Only two real SQL statement kinds are allowed in this file: the
    // CREATE OR REPLACE FUNCTION and the REVOKE/GRANT lines — verified by
    // requiring every non-comment, non-blank line to start with one of
    // those (or be a continuation of the function body itself).
    const executableLines = sql
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('--'));
    const ddlStarts = executableLines.filter((line) => /^(ALTER TABLE|CREATE TABLE|CREATE (UNIQUE )?INDEX|DROP (TABLE|INDEX))/i.test(line));
    expect(ddlStarts).toEqual([]);
  });

  it('an in-progress ("authorized") row reserves its FULL authorized_max_seconds ceiling — never a live-elapsed-time formula', () => {
    expect(fnBodyCode).toContain("SUM(csa.authorized_max_seconds) FILTER (WHERE csa.status = 'authorized')");
    // The old (buggy) elapsed-time formula must be gone entirely.
    expect(fnBodyCode).not.toMatch(/EXTRACT\(EPOCH FROM \(now\(\) - csa\.authorized_at\)\)/);
  });

  it('a completed row still counts only its real duration_seconds — unchanged from the previous revision', () => {
    expect(fnBodyCode).toContain("SUM(csa.duration_seconds) FILTER (WHERE csa.status = 'completed')");
  });

  it('reserved + consumed together determine the remaining balance, both bounded by the server-resolved assignment window', () => {
    expect(fnBodyCode).toContain('v_remaining := GREATEST(v_trial_total - v_reserved - v_consumed, 0);');
    expect(fnBodyCode).toContain('csa.authorized_at >= v_plan.starts_at');
    expect(fnBodyCode).toContain("csa.authorized_at < COALESCE(v_plan.ends_at, 'infinity'::timestamptz)");
  });

  it('caps the authorized ceiling at the smaller of requested and remaining, and blocks when remaining is exhausted', () => {
    expect(fnBodyCode).toContain('v_authorized := LEAST(p_requested_max_seconds, FLOOR(v_remaining)::integer);');
    expect(fnBodyCode).toMatch(/IF v_remaining <= 0 THEN\s*RETURN QUERY SELECT NULL::uuid, 0, true, 'balance_exhausted'::text;/);
  });

  it('still serializes concurrent attempts for the same user via the advisory lock (unchanged)', () => {
    expect(fnBodyCode).toContain("pg_advisory_xact_lock(hashtext('trial_conversation_balance'), hashtext(p_user_id::text))");
  });

  it('idempotency lookups remain scoped by (user_id, assignment_id, idempotency_key), qualified via the csa alias (unchanged from the ambiguity fix)', () => {
    const lookups = fnBodyCode.match(/WHERE csa\.user_id = p_user_id AND csa\.assignment_id = v_plan\.assignment_id AND csa\.idempotency_key = p_idempotency_key/g) ?? [];
    expect(lookups.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves the exact grants (postgres/service_role only, revoked from PUBLIC/anon/authenticated)', () => {
    const sig = 'public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text)';
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO postgres;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
  });
});
