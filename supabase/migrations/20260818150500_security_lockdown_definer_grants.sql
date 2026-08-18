-- ============================================================================
-- Security hardening — lock down SECURITY DEFINER function EXECUTE grants.
--
-- Principle: an authenticated client is NOT a trusted client. Internal
-- worker/cron functions, and functions that mutate authoritative state while
-- accepting a caller-supplied user id, must never be directly invocable by
-- `anon`/`authenticated`. `REVOKE ... FROM PUBLIC` alone is INSUFFICIENT when
-- an earlier migration issued an explicit `GRANT ... TO anon/authenticated`
-- (those survive a PUBLIC revoke) — so this migration revokes each role
-- EXPLICITLY. It is the corrective migration that leaves EXISTING databases
-- (homologation and production) safe after deploy, independent of whatever the
-- historical grants were.
--
-- Every block is idempotent, additive, and signature-agnostic (it resolves the
-- live oid, so it applies to whatever overload exists and silently skips a
-- function that is absent in a given environment).
-- ============================================================================

-- ── (A) Internal worker / cron / shared-acquire / cross-user-resync RPCs ─────
-- These are called EXCLUSIVELY by trusted server code (service-role client) or
-- by pg_cron. Application call sites verified service-role-only:
--   claim_next_listening_job / heartbeat_listening_job → cron route
--     (getJobsServiceClient) + CLI script (service-role client)
--   listening_cron_* → pg_cron only (no app call site)
--   acquire_or_get_listening_shared_story → getListeningServiceClient
--   acquire_or_get_shared_content_item   → getCurriculumServiceClient
--   resync_curriculum_progress → getCurriculumServiceClient (every caller).
-- resync accepts p_user_id and rewrites another account's curriculum pointer;
-- service_role-only is the identity guarantee (no client can reach it at all),
-- closing the cross-user (IDOR) exposure at the grant layer.
do $$
declare v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'claim_next_listening_job',
        'heartbeat_listening_job',
        'listening_cron_dispatch_jobs',
        'listening_cron_ensure_inventory',
        'listening_cron_repair_stuck_jobs',
        'acquire_or_get_listening_shared_story',
        'acquire_or_get_shared_content_item',
        'resync_curriculum_progress'
      ])
  loop
    execute format('revoke all on function %s from public', v_fn);
    execute format('revoke all on function %s from anon', v_fn);
    execute format('revoke all on function %s from authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end$$;

-- ── (B) Trigger-only / signup functions — never meant to be called directly ──
-- These are AFTER-INSERT / BEFORE-INSERT trigger functions (and the signup
-- trial grant). Triggers fire as the table owner regardless of any caller
-- EXECUTE grant, so removing the client grants changes no behavior and removes
-- a pointless direct-call surface.
do $$
declare v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'grant_signup_trial_v1',
        'set_ai_prefs_user_id',
        'set_conversation_session_user_id',
        'set_review_group_item_user_id'
      ])
  loop
    execute format('revoke all on function %s from public', v_fn);
    execute format('revoke all on function %s from anon', v_fn);
    execute format('revoke all on function %s from authenticated', v_fn);
  end loop;
end$$;

-- ── (C) Pronunciation lifecycle + error-review — drop the useless anon grant ─
-- These are legitimately called by the frontend/API with the caller's own JWT
-- and enforce ownership internally via auth.uid(); `authenticated` therefore
-- stays. But they were also granted to `anon`, which can never satisfy
-- auth.uid() and has no business reaching them — revoke it (defense in depth,
-- clears the anon_security_definer advisor) without touching the working
-- authenticated path.
do $$
declare v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'reserve_pronunciation_assessment',
        'complete_pronunciation_assessment',
        'fail_pronunciation_assessment',
        'compensate_pronunciation_assessment',
        'complete_pronunciation_training_assessment',
        'fail_pronunciation_training_assessment',
        'compensate_pronunciation_training_assessment',
        'get_error_review_session',
        'submit_error_review_item'
      ])
  loop
    execute format('revoke all on function %s from anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end$$;

-- ── (D) Fix mutable search_path on every privileged / project-owned function ──
-- A SECURITY DEFINER function without a pinned search_path can be hijacked by a
-- caller who prepends a schema; pinning it to `public` closes that class
-- (supabase advisor: function_search_path_mutable). Applied to every
-- non-extension function in `public` that lacks an explicit search_path — safe
-- and behaviour-preserving (these functions already reference public.* /
-- pg_catalog builtins). Extension-owned functions (pg_net, etc.) are excluded.
do $$
declare v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'   -- skip extension-owned
      )
      and (
        p.proconfig is null
        or not exists (
          select 1 from unnest(p.proconfig) cfg
          where cfg like 'search_path=%'
        )
      )
  loop
    execute format('alter function %s set search_path = public', v_fn);
  end loop;
end$$;
