/**
 * Static SQL-text assertions on the three Etapa 11 corrective migrations
 * added by the 2026-07-23 database-security + realtime-hardening audit:
 *   - 20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit.sql
 *   - 20260723010000_realtime_hard_control_evidence_schema.sql
 *   - 20260723020000_conversation_session_heartbeat_and_hangup_evidence.sql
 *
 * None of these migrations are applied to any database from this test file
 * (no live connection here) — same posture as
 * api/__tests__/ai-gateway-migration-security.test.ts, which this file
 * mirrors for structure. Real application + postcheck happens against the
 * live Primary Database separately (see the Etapa 11 diagnostic report).
 * What's provable purely from source text: privilege revocation is present
 * verbatim, RLS/zero-policy posture is preserved, the evidence-recording
 * function structurally cannot derive status='passed' from anything but
 * all-8-scenarios-passed, and the cron registration targets the real
 * internal endpoint with the real secret-based auth header.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'supabase', 'migrations');
const securitySql = readFileSync(resolve(MIGRATIONS_DIR, '20260723000000_revoke_new_tables_default_grants_and_extend_privilege_audit.sql'), 'utf8');
const evidenceSql = readFileSync(resolve(MIGRATIONS_DIR, '20260723010000_realtime_hard_control_evidence_schema.sql'), 'utf8');
const heartbeatSql = readFileSync(resolve(MIGRATIONS_DIR, '20260723020000_conversation_session_heartbeat_and_hangup_evidence.sql'), 'utf8');
const sweepPrivilegesSql = readFileSync(resolve(MIGRATIONS_DIR, '20260723030000_fix_conversation_sweep_cron_privileges.sql'), 'utf8');

describe('20260723000000 — revoke default grants + extend privilege audit', () => {
  it('revokes ALL from both anon and authenticated on both new tables', () => {
    for (const table of ['conversation_session_authorizations', 'realtime_hard_control_validations']) {
      expect(securitySql).toMatch(new RegExp(`REVOKE ALL ON public\\.${table}\\s+FROM anon;`));
      expect(securitySql).toMatch(new RegExp(`REVOKE ALL ON public\\.${table}\\s+FROM authenticated;`));
    }
  });

  it('_gateway_audit_database_privileges_v1 is replaced (not just referenced) and now lists both new tables', () => {
    expect(securitySql).toMatch(/CREATE OR REPLACE FUNCTION public\._gateway_audit_database_privileges_v1\(\)/);
    const fnBody = securitySql.slice(
      securitySql.indexOf('CREATE OR REPLACE FUNCTION public._gateway_audit_database_privileges_v1'),
      securitySql.indexOf('$function$;', securitySql.indexOf('CREATE OR REPLACE FUNCTION public._gateway_audit_database_privileges_v1')),
    );
    expect(fnBody).toContain("'conversation_session_authorizations'");
    expect(fnBody).toContain("'realtime_hard_control_validations'");
    // Still covers every original object too — an extension, never a
    // narrowing, of what the audit checks.
    expect(fnBody).toContain("'ai_gateway_concurrency_validations'");
  });

  it('the inline validation independently re-checks has_table_privilege, not just the function it just replaced', () => {
    expect(securitySql).toMatch(/has_table_privilege\('anon',\s*'public\.conversation_session_authorizations'/);
    expect(securitySql).toMatch(/has_table_privilege\('authenticated',\s*'public\.realtime_hard_control_validations'/);
  });

  it('no CREATE POLICY statement is introduced for either table — RLS+zero-policy posture is preserved, not weakened', () => {
    expect(securitySql).not.toMatch(/CREATE POLICY/i);
  });
});

describe('20260723010000 — realtime hard-control evidence schema', () => {
  it('adds git_sha, environment, scenario_results, evidence as new columns', () => {
    expect(evidenceSql).toMatch(/ADD COLUMN IF NOT EXISTS git_sha\s+TEXT/);
    expect(evidenceSql).toMatch(/ADD COLUMN IF NOT EXISTS environment\s+TEXT/);
    expect(evidenceSql).toMatch(/ADD COLUMN IF NOT EXISTS scenario_results\s+JSONB/);
    expect(evidenceSql).toMatch(/ADD COLUMN IF NOT EXISTS evidence\s+JSONB/);
  });

  it('git_sha is constrained to a 40-char lowercase hex commit SHA at the column level', () => {
    expect(evidenceSql).toMatch(/CHECK \(git_sha ~ '\^\[0-9a-f\]\{40\}\$'\)/);
  });

  it('the old 6-arg record_realtime_hard_control_validation_v1 is explicitly dropped before the new signature is created — no permissive overload left reachable', () => {
    expect(evidenceSql).toContain('DROP FUNCTION IF EXISTS public.record_realtime_hard_control_validation_v1(text, text, text, text, text, text);');
  });

  it('the new function never accepts status as a caller-supplied parameter — it is derived internally', () => {
    const fnBody = evidenceSql.slice(
      evidenceSql.indexOf('CREATE OR REPLACE FUNCTION public.record_realtime_hard_control_validation_v1'),
      evidenceSql.indexOf('REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1'),
    );
    expect(fnBody).not.toMatch(/p_status\s+TEXT/);
    expect(fnBody).toMatch(/v_derived_status\s*:=\s*CASE WHEN v_all_passed THEN 'passed' ELSE 'failed' END/);
  });

  it('the function requires exactly the 8 named scenario keys — rejects both missing and unexpected-extra keys', () => {
    const fnBody = evidenceSql.slice(
      evidenceSql.indexOf('CREATE OR REPLACE FUNCTION public.record_realtime_hard_control_validation_v1'),
      evidenceSql.indexOf('REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1'),
    );
    const requiredKeys = [
      'reservation_authorization', 'concurrency', 'limit_rejection', 'normal_termination',
      'disconnection', 'timeout', 'reservation_release', 'orphan_cleanup',
    ];
    for (const key of requiredKeys) {
      expect(fnBody).toContain(`'${key}'`);
    }
    expect(fnBody).toMatch(/COUNT\(\*\) FROM jsonb_object_keys\(p_scenario_results\)\) <> array_length\(v_required_keys, 1\)/);
    expect(fnBody).toMatch(/scenario_results missing required key/);
  });

  it('the function rejects evidence that looks like a raw secret (API key / bearer token pattern)', () => {
    const fnBody = evidenceSql.slice(
      evidenceSql.indexOf('CREATE OR REPLACE FUNCTION public.record_realtime_hard_control_validation_v1'),
      evidenceSql.indexOf('REVOKE ALL ON FUNCTION public.record_realtime_hard_control_validation_v1'),
    );
    expect(fnBody).toMatch(/sk-\[A-Za-z0-9_-\]\{10,\}/);
    expect(fnBody).toMatch(/bearer\\s\+\[A-Za-z0-9\._-\]\{10,\}/);
  });

  it('the new function signature is REVOKEd from PUBLIC, anon, and authenticated', () => {
    const sig = 'public.record_realtime_hard_control_validation_v1(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB)';
    expect(evidenceSql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC;`);
    expect(evidenceSql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM anon;`);
    expect(evidenceSql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM authenticated;`);
  });

  it('includes both positive and negative inline self-tests, and cleans up synthetic rows before COMMIT', () => {
    expect(evidenceSql).toMatch(/SELF-TEST FAILED: all-passed scenario_results should derive status=passed/);
    expect(evidenceSql).toMatch(/SELF-TEST FAILED: missing scenario key should have raised an exception/);
    expect(evidenceSql).toMatch(/SELF-TEST FAILED: malformed git_sha should have raised an exception/);
    expect(evidenceSql).toMatch(/SELF-TEST FAILED: invalid environment should have raised an exception/);
    expect(evidenceSql).toMatch(/DELETE FROM public\.realtime_hard_control_validations WHERE hard_control_version = '__migration_selftest__'/);
  });

  it('_gateway_audit_database_privileges_v1 is updated again to the new 9-arg function signature (no stale signature left in the audit list)', () => {
    expect(evidenceSql).toContain("'record_realtime_hard_control_validation_v1(text, text, text, text, text, jsonb, text, text, jsonb)'");
  });
});

describe('20260723020000 — conversation session heartbeat + hangup evidence + sweep cron', () => {
  it('adds last_heartbeat_at and the three hangup outcome columns to ai_provider_sessions', () => {
    expect(heartbeatSql).toMatch(/ADD COLUMN IF NOT EXISTS last_heartbeat_at\s+TIMESTAMPTZ/);
    expect(heartbeatSql).toMatch(/ADD COLUMN IF NOT EXISTS hangup_status\s+TEXT NOT NULL DEFAULT 'not_attempted'/);
    expect(heartbeatSql).toMatch(/ADD COLUMN IF NOT EXISTS hangup_at\s+TIMESTAMPTZ/);
    expect(heartbeatSql).toMatch(/ADD COLUMN IF NOT EXISTS hangup_http_status\s+INTEGER/);
  });

  it('hangup_status is constrained to the 3-value enum', () => {
    expect(heartbeatSql).toMatch(/CHECK \(hangup_status IN \('not_attempted', 'ok', 'failed'\)\)/);
  });

  it('the sweep-candidates index is partial (non-terminal statuses only), keeping it cheap regardless of history size', () => {
    expect(heartbeatSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_aps_sweep_candidates[\s\S]*?WHERE status IN \('active', 'authorized', 'connecting'\)/);
  });

  it('includes a self-test that actually inserts and expects the hangup_status CHECK to reject an invalid value', () => {
    expect(heartbeatSql).toMatch(/SELF-TEST FAILED: hangup_status CHECK constraint did not reject an invalid value/);
    expect(heartbeatSql).toMatch(/WHEN check_violation THEN NULL; -- expected/);
  });

  it('the cron function is REVOKEd from PUBLIC and targets the real internal sweep endpoint with the shared cron secret', () => {
    expect(heartbeatSql).toContain('REVOKE ALL ON FUNCTION public.conversation_cron_sweep_stale_sessions() FROM PUBLIC;');
    expect(heartbeatSql).toContain("'/api/internal/listening/conversation-sweep'");
    expect(heartbeatSql).toMatch(/'Authorization', 'Bearer ' \|\| v_secret/);
  });

  it('reuses the existing cron_secret/app_base_url Vault secrets — introduces no new secret', () => {
    expect(heartbeatSql).toMatch(/name = 'cron_secret'/);
    expect(heartbeatSql).toMatch(/name = 'app_base_url'/);
    expect(heartbeatSql).not.toMatch(/vault\.create_secret/);
  });

  it('the cron job is scheduled every minute, unscheduling any prior registration first (idempotent re-apply)', () => {
    expect(heartbeatSql).toMatch(/cron\.unschedule\('conversation-sweep-stale-sessions'\)/);
    expect(heartbeatSql).toMatch(/cron\.schedule\(\s*\n\s*'conversation-sweep-stale-sessions',\s*\n\s*'\* \* \* \* \*'/);
  });

  it('never activates enforce or touches gateway_mode/runtime_status', () => {
    expect(heartbeatSql).not.toMatch(/gateway_mode\s*=\s*'enforce'/);
    expect(heartbeatSql).not.toMatch(/UPDATE\s+public\.ai_runtime_controls/i);
  });
});

describe('20260723030000 — fix conversation_cron_sweep_stale_sessions privileges (self-discovered gap)', () => {
  it('pins search_path (missing in the original 20260723020000 declaration, flagged by the Security Advisor as function_search_path_mutable)', () => {
    expect(sweepPrivilegesSql).toMatch(/SECURITY DEFINER SET search_path = public/);
  });

  it('explicitly revokes from anon and authenticated, not just PUBLIC — a bare REVOKE FROM PUBLIC left it directly callable by both (confirmed live via has_function_privilege before this fix)', () => {
    expect(sweepPrivilegesSql).toContain('REVOKE ALL ON FUNCTION public.conversation_cron_sweep_stale_sessions() FROM anon;');
    expect(sweepPrivilegesSql).toContain('REVOKE ALL ON FUNCTION public.conversation_cron_sweep_stale_sessions() FROM authenticated;');
  });

  it('the inline validation independently re-checks has_function_privilege for both roles', () => {
    expect(sweepPrivilegesSql).toMatch(/has_function_privilege\('anon', 'public\.conversation_cron_sweep_stale_sessions\(\)', 'EXECUTE'\)/);
    expect(sweepPrivilegesSql).toMatch(/has_function_privilege\('authenticated', 'public\.conversation_cron_sweep_stale_sessions\(\)', 'EXECUTE'\)/);
  });

  it('preserves the exact same function body/behavior — corrective for privilege only, never a logic change', () => {
    expect(sweepPrivilegesSql).toContain("url     := v_url || '/api/internal/listening/conversation-sweep',");
    expect(sweepPrivilegesSql).toContain("SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;");
  });
});
