/**
 * Static SQL-text assertions on
 * 20260724030000_ai_gateway_conservative_budget_estimate_fix.sql — the fix
 * for reserve_gateway_usage_v1's fail-open NULL-estimate budget bug
 * (COALESCE(p_estimated_cost_usd, 0) silently treated an unresolved
 * worst-case cost estimate as "this call is free").
 *
 * This migration is NOT applied to any database from this test file (no
 * live connection here) — same posture as
 * api/__tests__/etapa11-corrective-migrations-static.test.ts, which this
 * file mirrors for structure. What's provable purely from source text: the
 * new NULL-blocks-when-configured check is present and ordered before the
 * bucket touch/increment, the numeric comparison path is otherwise
 * unchanged (same body as the last-applied 20260718030000 version), the
 * function signature/grants are preserved exactly, and the migration
 * self-validates all three cases (NULL+configured blocks,
 * resolved-estimate still reserves, NULL+unconfigured still reserves)
 * before it would ever commit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'supabase', 'migrations');
const sql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260724030000_ai_gateway_conservative_budget_estimate_fix.sql'),
  'utf8',
);

function fnBody(source: string): string {
  return source.slice(
    source.indexOf('CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1'),
    source.indexOf('$function$;'),
  );
}

describe('20260724030000 — reserve_gateway_usage_v1 conservative budget estimate fix', () => {
  it('replaces reserve_gateway_usage_v1 with the exact preserved signature (no DROP, no new overload)', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.reserve_gateway_usage_v1(\n' +
      '  p_idempotency_key text,\n' +
      '  p_user_id uuid,\n' +
      '  p_initiated_by_user_id uuid,\n' +
      '  p_feature_key text,\n' +
      '  p_provider text,\n' +
      '  p_model text,\n' +
      '  p_metrics jsonb,\n' +
      '  p_budget_scopes jsonb,\n' +
      '  p_estimated_cost_usd numeric,\n' +
      '  p_expires_in_seconds integer\n' +
      ')',
    );
    expect(sql).not.toMatch(/DROP FUNCTION/);
    expect(sql).toMatch(/RETURNS TABLE\(reservation_id uuid, status text, expires_at timestamp with time zone, blocked_reason text, blocked_detail text\)/);
  });

  it('a NULL estimate is checked and blocks BEFORE touching/locking the budget bucket for a scope that has a configured limit', () => {
    const body = fnBody(sql);
    const nullCheckIdx = body.indexOf('IF p_estimated_cost_usd IS NULL THEN');
    const touchBucketIdx = body.indexOf('_gateway_touch_budget_bucket_v1', body.indexOf('Phase 2'));
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(touchBucketIdx).toBeGreaterThan(-1);
    expect(nullCheckIdx).toBeLessThan(touchBucketIdx);
  });

  it('the NULL-blocks branch sets BUDGET_EXCEEDED with a blocked_detail suffixed :estimate_unavailable', () => {
    const body = fnBody(sql);
    const nullBranch = body.slice(
      body.indexOf('IF p_estimated_cost_usd IS NULL THEN'),
      body.indexOf('END IF;', body.indexOf('IF p_estimated_cost_usd IS NULL THEN')),
    );
    expect(nullBranch).toContain("v_blocked_reason := 'BUDGET_EXCEEDED';");
    expect(nullBranch).toContain(":estimate_unavailable");
  });

  it('the NULL-blocks branch is scoped inside the limit_usd-configured path — a scope with no configured limit is still skipped via CONTINUE before ever reaching it', () => {
    const body = fnBody(sql);
    const phase2 = body.slice(body.indexOf('Phase 2'), body.indexOf('Phase 3'));
    const continueIdx = phase2.indexOf('CONTINUE;');
    const nullCheckIdx = phase2.indexOf('IF p_estimated_cost_usd IS NULL THEN');
    expect(continueIdx).toBeGreaterThan(-1);
    expect(nullCheckIdx).toBeGreaterThan(continueIdx);
  });

  it('the resolved-numeric-estimate comparison is unchanged from the previously-applied version (COALESCE removed only from the comparison, not reintroduced as a silent default)', () => {
    const body = fnBody(sql);
    expect(body).toContain('IF p_estimated_cost_usd > GREATEST(v_available, 0) THEN');
    // The old, buggy comparison must be gone from the live comparison path.
    expect(body).not.toContain('IF COALESCE(p_estimated_cost_usd, 0) > GREATEST(v_available, 0) THEN');
  });

  it('Phase 3 (write) still defensively COALESCEs — dead for any scope with a real configured limit (Phase 2 already blocked a NULL estimate there), but harmless', () => {
    const body = fnBody(sql);
    const phase3 = body.slice(body.indexOf('Phase 3'));
    expect(phase3).toContain('reserved_cost_usd + COALESCE(p_estimated_cost_usd, 0)');
  });

  it('permissions are restated exactly (service_role/postgres only, anon/authenticated explicitly revoked)', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.reserve_gateway_usage_v1(text, uuid, uuid, text, text, text, jsonb, jsonb, numeric, integer)\n  TO service_role, postgres;',
    );
  });

  it('self-validates all three cases before it would ever commit: NULL+configured blocks, resolved estimate still reserves, NULL+unconfigured still reserves', () => {
    expect(sql).toMatch(/NULL estimate against a configured budget scope should block with BUDGET_EXCEEDED/);
    expect(sql).toMatch(/a resolved estimate under budget should still reserve normally/);
    expect(sql).toMatch(/a NULL estimate against an unconfigured \(no limit_usd\) scope must still reserve normally/);
  });

  it('the validation block asserts a blocked NULL-estimate call never persists a usage_reservations row', () => {
    expect(sql).toMatch(/a blocked NULL-estimate call must never persist a reservation row/);
  });

  it('cleans up every synthetic row it created before COMMIT, and aborts on any drift to protected tables', () => {
    expect(sql).toMatch(/DELETE FROM public\.usage_reservations WHERE idempotency_key IN \(v_idem_key_a, v_idem_key_b, v_idem_key_c\);/);
    expect(sql).toMatch(/ABORT: ai_runtime_controls changed during this migration/);
    expect(sql).toMatch(/ABORT: provider_pricing changed during this migration/);
    expect(sql).toMatch(/ABORT: consumption\/reservation table row counts drifted/);
  });

  it('never touches gateway_mode, runtime_status, or provider_pricing directly (budget-check fix only)', () => {
    expect(sql).not.toMatch(/UPDATE\s+public\.ai_runtime_controls/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.provider_pricing/i);
    expect(sql).not.toMatch(/INSERT INTO\s+public\.provider_pricing/i);
  });
});
