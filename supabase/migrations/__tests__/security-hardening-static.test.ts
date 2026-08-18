/**
 * Static regression guards for the security-hardening migrations. They don't
 * run SQL — they lock in the structural invariants so a future edit that
 * silently re-opens one of these holes fails CI. Each assertion maps to a
 * concrete vulnerability class from the audit:
 *   - internal/worker RPCs executable by anon/authenticated
 *   - a global cache writable directly by authenticated
 *   - quota RPCs trusting a client-supplied p_unlimited / limit
 *   - a cross-user (IDOR) resync executable by clients
 *   - a SECURITY DEFINER view bypassing RLS
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = join(__dirname, '..');
const read = (f: string) => readFileSync(join(MIG, f), 'utf8');

describe('20260818150000 — shared cache + legacy policies lockdown', () => {
  const sql = read('20260818150000_security_lockdown_shared_cache_and_legacy_policies.sql');

  it('removes the client-facing write policies on the global grammar_explanations cache', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS ge_insert ON public\.grammar_explanations/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS ge_update ON public\.grammar_explanations/);
  });

  it('drops the legacy user_id-IS-NULL permissive policies on english_learning_memory', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Allow select english learning memory" ON public\.english_learning_memory/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Allow insert english learning memory" ON public\.english_learning_memory/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Allow update english learning memory" ON public\.english_learning_memory/);
  });
});

describe('20260818150500 — SECURITY DEFINER grant lockdown', () => {
  const sql = read('20260818150500_security_lockdown_definer_grants.sql');

  it('revokes worker/cron/shared-acquire/resync RPCs from public, anon AND authenticated', () => {
    // The explicit anon + authenticated revokes are the point: REVOKE FROM
    // PUBLIC alone would leave earlier explicit role grants intact.
    for (const fn of [
      'claim_next_listening_job', 'heartbeat_listening_job',
      'listening_cron_dispatch_jobs', 'listening_cron_ensure_inventory', 'listening_cron_repair_stuck_jobs',
      'acquire_or_get_listening_shared_story', 'acquire_or_get_shared_content_item',
      'resync_curriculum_progress',
    ]) {
      expect(sql).toContain(`'${fn}'`);
    }
    expect(sql).toMatch(/revoke all on function %s from anon/);
    expect(sql).toMatch(/revoke all on function %s from authenticated/);
    expect(sql).toMatch(/grant execute on function %s to service_role/);
  });

  it('pins a safe search_path on every non-extension privileged function', () => {
    expect(sql).toMatch(/alter function %s set search_path = public/);
    expect(sql).toMatch(/deptype = 'e'/); // extension-owned functions are skipped
  });
});

describe('20260818151000 — quota RPCs are service_role-only, identity from p_user_id', () => {
  const sql = read('20260818151000_security_quota_rpcs_service_role_only.sql');

  const quotaFns: Array<[string, string]> = [
    ['consume_listening_pending_story', 'uuid, uuid, date, integer, boolean'],
    ['create_pronunciation_training_text', 'uuid, date, text, text, boolean, integer, boolean, uuid, text'],
    ['reserve_pronunciation_training_assessment', 'uuid, date, text, uuid, integer, boolean'],
    ['reserve_writing_review', 'uuid, uuid, boolean, integer'],
  ];

  it('adds p_user_id as the first parameter (identity no longer from a client JWT)', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.consume_listening_pending_story\(\s*\n\s*p_user_id uuid/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.create_pronunciation_training_text\(\s*\n\s*p_user_id uuid/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.reserve_pronunciation_training_assessment\(\s*\n\s*p_user_id uuid/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.reserve_writing_review\(\s*\n\s*p_user_id uuid/);
    // The identity is p_user_id, never auth.uid(), in every one.
    expect(sql).not.toMatch(/v_user_id := auth\.uid\(\)/);
  });

  it('revokes each from PUBLIC/anon/authenticated and grants only service_role', () => {
    for (const [fn, args] of quotaFns) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}(${args}) FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(${args}) TO service_role`);
    }
  });
});

describe('20260818151500 — commercial conversation atomic authorization', () => {
  const sql = read('20260818151500_conversation_commercial_atomic_authorization.sql');

  it('is service_role-only (never client-callable)', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.authorize_commercial_conversation_session_v1\(uuid, integer, date, integer, boolean, integer, text\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.authorize_commercial_conversation_session_v1\(uuid, integer, date, integer, boolean, integer, text\) TO service_role/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.authorize_commercial_conversation_session_v1[^;]*TO (authenticated|anon)/);
  });

  it('re-resolves the plan server-side and never authorizes a trial balance', () => {
    expect(sql).toMatch(/admin_resolve_effective_plan_v1\(p_user_id, now\(\)\)/);
    expect(sql).toMatch(/plan_code IS NOT DISTINCT FROM 'trial'/); // trial goes through the other RPC
  });

  it('reserves the FULL authorized_max_seconds of open rows under a per-user advisory lock', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtext\('commercial_conversation_balance'\), hashtext\(p_user_id::text\)\)/);
    expect(sql).toMatch(/SUM\(csa\.authorized_max_seconds\) FILTER \(WHERE csa\.status = 'authorized'\)/);
  });
});

describe('20260818152000 — privileged view is security_invoker, not client-facing', () => {
  const sql = read('20260818152000_security_view_invoker_and_grants.sql');

  it('sets security_invoker on and revokes anon/authenticated', () => {
    expect(sql).toMatch(/SET \(security_invoker = on\)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.listening_questions_public FROM anon/);
    expect(sql).toMatch(/REVOKE ALL ON public\.listening_questions_public FROM authenticated/);
  });
});
