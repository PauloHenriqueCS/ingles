/**
 * Static SQL-text assertions for
 * 20260727224300_fix_authorize_trial_conversation_session_ambiguity.sql —
 * no live database connection here (same posture as the other migration
 * static tests in this directory). This migration exists because a REAL bug
 * (Postgres error 42702, column reference "authorized_max_seconds" is
 * ambiguous) was found running the previous version live against
 * lemon-homolog — the earlier static tests (regex over SQL text) could not
 * have caught this, since they never execute the SQL. These tests assert
 * the qualification itself, as a floor for future regressions of the same
 * class of bug — they do not replace running the function against a real
 * Postgres instance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(
  resolve(__dirname, '..', '..', 'migrations', '20260727224300_fix_authorize_trial_conversation_session_ambiguity.sql'),
  'utf8',
);

const fnBody = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.authorize_trial_conversation_session_v1'),
  sql.lastIndexOf('$function$;'),
);

// SQL line-comments (-- ...) stripped for the structural checks below — the
// migration's own prose intentionally discusses "authorized_max_seconds"
// and "csa.authorized_max_seconds" in comments explaining the fix, which
// would otherwise pollute a naive text search over the real code.
const fnBodyCode = fnBody.replace(/--.*$/gm, '');

describe('20260727224300 — fix authorize_trial_conversation_session_v1 ambiguity', () => {
  it('preserves the exact same signature, return shape, SECURITY DEFINER, and search_path', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.authorize_trial_conversation_session_v1\(\s*\n\s*p_user_id uuid,\s*\n\s*p_requested_max_seconds integer,\s*\n\s*p_session_date date,\s*\n\s*p_gateway_budget_reservation_id uuid,\s*\n\s*p_gateway_session_id uuid,\s*\n\s*p_idempotency_key text\s*\n\)/,
    );
    expect(sql).toContain('RETURNS TABLE(authorization_id uuid, authorized_max_seconds integer, blocked boolean, blocked_reason text)');
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it('never references authorized_max_seconds without a table alias qualifier anywhere in the function CODE (comments excluded)', () => {
    // Every real-code occurrence must be either the RETURNS TABLE output
    // name itself (the function signature, checked separately above) or
    // qualified as csa.authorized_max_seconds. A bare, unqualified
    // "authorized_max_seconds" inside the code (outside an INSERT INTO
    // column list, which is never ambiguous, and outside the signature) is
    // exactly the bug this migration fixes.
    const codeWithoutSignatureOrInsertLists = fnBodyCode
      .replace(/RETURNS TABLE\([^)]*\)/, '')
      .replace(/INSERT INTO public\.conversation_session_authorizations \([^)]*\)/g, '');
    const bareOccurrences = codeWithoutSignatureOrInsertLists.match(/(?<!csa\.)\bauthorized_max_seconds\b/g) ?? [];
    expect(bareOccurrences.length).toBe(0);
  });

  it('qualifies all 5 known occurrences with the csa alias: pre-lock lookup, post-lock lookup, unlimited-branch fallback, consumption sum, finite-branch fallback', () => {
    const qualified = fnBodyCode.match(/csa\.authorized_max_seconds/g) ?? [];
    expect(qualified.length).toBe(5);
  });

  it('every SELECT reading conversation_session_authorizations declares the csa alias', () => {
    const tableRefs = fnBodyCode.match(/FROM public\.conversation_session_authorizations(\s+csa)?/g) ?? [];
    expect(tableRefs.length).toBeGreaterThan(0);
    for (const ref of tableRefs) {
      expect(ref).toMatch(/FROM public\.conversation_session_authorizations\s+csa$/);
    }
  });

  it('the consumption-sum query (previously unqualified, the 5th occurrence found in this revision) also qualifies status/duration_seconds/authorized_at via csa', () => {
    expect(fnBodyCode).toContain("WHEN csa.status = 'completed' THEN COALESCE(csa.duration_seconds, 0)");
    expect(fnBodyCode).toContain('EXTRACT(EPOCH FROM (now() - csa.authorized_at))');
  });

  it('INSERT INTO column lists remain unqualified (never ambiguous in that syntactic position) — no unnecessary churn', () => {
    expect(fnBodyCode).toMatch(/INSERT INTO public\.conversation_session_authorizations \(\s*\n\s*user_id, session_date, authorized_max_seconds,\s*\n\s*gateway_budget_reservation_id, gateway_session_id, idempotency_key, assignment_id\s*\n\s*\) VALUES \(/g);
  });

  it('preserves the exact grants (postgres/service_role only, revoked from PUBLIC/anon/authenticated)', () => {
    const sig = 'public.authorize_trial_conversation_session_v1(uuid, integer, date, uuid, uuid, text)';
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO postgres;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
  });

  it('preserves the exact same business logic (blocked_reason values, advisory lock key, balance formula) — purely syntactic fix', () => {
    expect(fnBody).toContain("'no_active_trial'::text");
    expect(fnBody).toContain("'invalid_request'::text");
    expect(fnBody).toContain("'balance_exhausted'::text");
    expect(fnBody).toContain("pg_advisory_xact_lock(hashtext('trial_conversation_balance'), hashtext(p_user_id::text))");
    expect(fnBody).toContain('v_remaining := GREATEST(v_trial_total - v_consumed, 0);');
    expect(fnBody).toContain('v_authorized := LEAST(p_requested_max_seconds, FLOOR(v_remaining)::integer);');
  });
});
