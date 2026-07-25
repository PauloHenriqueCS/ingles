-- Fixes two independently-audited defects in the Listening shared-story
-- persistence introduced by 20260724050000/20260724050001. Scope is
-- EXCLUSIVELY these two objects — no other table, function, policy, or
-- data is touched.
--
-- 1. acquire_or_get_listening_shared_story's ON CONFLICT ... DO UPDATE ...
--    WHERE clause read:
--      WHERE status = 'failed' OR lock_expires_at < now()
--    lock_expires_at is set ONCE, at creation/takeover, and is never
--    refreshed after a story reaches status='ready' — so once it aged
--    past the original lock_duration_seconds, ANY later request would
--    match the second half of that OR and silently take the row back to
--    'generating', even though it was already ready. Confirmed in
--    production: a ready row was regenerated (new OpenAI call, two new
--    Azure TTS calls, existing audio paths overwritten). Fix: a row may
--    only be taken over when status='failed', or when status='generating'
--    AND its lock has expired — status='ready' is never reacquirable via
--    the lock-expiry branch, full stop.
--
--    Defense in depth: on successful persist, lock_expires_at is now
--    cleared to NULL for a ready row (mirroring the nullable/cleared-on-
--    completion lock convention already used by listening_jobs,
--    listening_generation_jobs, and listening_generation_sessions in this
--    schema) — requires the column to allow NULL, which it did not
--    (NOT NULL since creation); relaxed here. This is redundant with the
--    condition fix above (a 'ready' row can never match the WHERE clause
--    regardless of lock_expires_at) but removes the stale timestamp
--    entirely rather than merely ignoring it.
--
--    Does NOT touch the uq_lss_group_date UNIQUE (level_group,
--    practice_date) constraint, or any other column/table/behavior.
--
-- 2. listening_shared_stories / user_listening_shared_progress kept
--    Postgres's default anon/authenticated table grants (same class of
--    gap already fixed for other tables by 20260723000000 and
--    20260724050001, which only revoked the RPC's default PUBLIC EXECUTE
--    — it never touched the two tables' own default table grants).
--    listening_shared_stories has zero RLS policies (service-role-only by
--    design, same model as listening_generation_jobs) — anon/authenticated
--    get zero privileges. user_listening_shared_progress has RLS policies
--    for SELECT/INSERT/UPDATE (own rows only); authenticated keeps exactly
--    those three, losing the unused DELETE/TRUNCATE/REFERENCES/TRIGGER
--    default grant. No data or policy is altered.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1a. Reacquisition condition
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION acquire_or_get_listening_shared_story(
  p_level_group TEXT,
  p_target_level TEXT,
  p_practice_date DATE,
  p_lock_duration_seconds INTEGER
)
RETURNS TABLE (
  id UUID,
  status TEXT,
  won BOOLEAN,
  content JSONB,
  part1_audio_path TEXT,
  part2_audio_path TEXT,
  audio_mime_type TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at)
  VALUES (p_level_group, p_target_level, p_practice_date, 'generating', now() + make_interval(secs => p_lock_duration_seconds))
  ON CONFLICT (level_group, practice_date) DO UPDATE
    SET status = 'generating',
        target_level = EXCLUDED.target_level,
        lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
        error_message = NULL
    WHERE listening_shared_stories.status = 'failed'
       OR (listening_shared_stories.status = 'generating' AND listening_shared_stories.lock_expires_at < now())
  RETURNING listening_shared_stories.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'generating'::TEXT, true, NULL::JSONB, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM listening_shared_stories s
    WHERE s.level_group = p_level_group AND s.practice_date = p_practice_date;
END;
$$;

COMMENT ON FUNCTION acquire_or_get_listening_shared_story IS
  'Atomic lock acquisition for listening_shared_stories: wins (won=true) on a fresh insert, a takeover of a failed row, or a takeover of a generating row whose lock has expired; a ready row is NEVER reacquirable via lock expiry. Otherwise returns the existing ready/generating row unchanged (won=false).';

-- CREATE OR REPLACE preserves the existing ACL (same function OID), so
-- this is redundant with 20260724050001 in practice — reasserted anyway,
-- defensively, so this migration is correct standing alone even if that
-- guarantee is ever relied on incorrectly elsewhere.
REVOKE EXECUTE ON FUNCTION acquire_or_get_listening_shared_story(TEXT, TEXT, DATE, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION acquire_or_get_listening_shared_story(TEXT, TEXT, DATE, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. Defense in depth — allow clearing the lock on a ready row
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE listening_shared_stories ALTER COLUMN lock_expires_at DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Grants
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON listening_shared_stories FROM anon;
REVOKE ALL ON listening_shared_stories FROM authenticated;

REVOKE ALL ON user_listening_shared_progress FROM anon;
REVOKE ALL ON user_listening_shared_progress FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON user_listening_shared_progress TO authenticated;

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- Scenarios use synthetic practice_date values far in the future (year
-- 2099) so they can never collide with real traffic; all synthetic rows
-- are deleted before COMMIT regardless of pass/fail.

DO $$
DECLARE
  v_row RECORD;
BEGIN
  DELETE FROM public.listening_shared_stories WHERE practice_date BETWEEN '2099-06-01' AND '2099-06-05';

  -- Scenarios 1/2: status='ready' with an EXPIRED lock -> reused
  -- (won=false, status='ready'), and the row itself must still read
  -- 'ready' afterwards (never flipped to 'generating').
  INSERT INTO public.listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at, content)
  VALUES ('A1_A2', 'A1', '2099-06-01', 'ready', now() - interval '1 hour', '{"title":"validation"}'::jsonb);

  SELECT * INTO v_row FROM public.acquire_or_get_listening_shared_story('A1_A2', 'A1', '2099-06-01', 180);
  IF v_row.won IS DISTINCT FROM false OR v_row.status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'VALIDATION FAILED scenario 1: ready+expired-lock must be reused unchanged, got won=% status=%', v_row.won, v_row.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.listening_shared_stories WHERE level_group = 'A1_A2' AND practice_date = '2099-06-01' AND status <> 'ready') THEN
    RAISE EXCEPTION 'VALIDATION FAILED scenario 2: a ready row was flipped away from ready by an expired-lock reacquire attempt';
  END IF;

  -- Scenario 3: status='generating' with a LIVE lock -> NOT reacquirable.
  INSERT INTO public.listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at)
  VALUES ('A1_A2', 'A1', '2099-06-02', 'generating', now() + interval '1 hour');

  SELECT * INTO v_row FROM public.acquire_or_get_listening_shared_story('A1_A2', 'A1', '2099-06-02', 180);
  IF v_row.won IS DISTINCT FROM false OR v_row.status IS DISTINCT FROM 'generating' THEN
    RAISE EXCEPTION 'VALIDATION FAILED scenario 3: generating+live-lock must NOT be reacquirable, got won=% status=%', v_row.won, v_row.status;
  END IF;

  -- Scenario 4: status='generating' with an EXPIRED lock -> reacquirable.
  INSERT INTO public.listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at)
  VALUES ('A1_A2', 'A1', '2099-06-03', 'generating', now() - interval '1 hour');

  SELECT * INTO v_row FROM public.acquire_or_get_listening_shared_story('A1_A2', 'A1', '2099-06-03', 180);
  IF v_row.won IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'VALIDATION FAILED scenario 4: generating+expired-lock must be reacquirable, got won=%', v_row.won;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listening_shared_stories WHERE level_group = 'A1_A2' AND practice_date = '2099-06-03' AND lock_expires_at > now()) THEN
    RAISE EXCEPTION 'VALIDATION FAILED scenario 4: lock_expires_at was not refreshed on takeover';
  END IF;

  -- Scenario 5: status='failed' -> always reacquirable.
  INSERT INTO public.listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at)
  VALUES ('A1_A2', 'A1', '2099-06-04', 'failed', now() + interval '1 hour');

  SELECT * INTO v_row FROM public.acquire_or_get_listening_shared_story('A1_A2', 'A1', '2099-06-04', 180);
  IF v_row.won IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'VALIDATION FAILED scenario 5: a failed row must always be reacquirable, got won=%', v_row.won;
  END IF;

  DELETE FROM public.listening_shared_stories WHERE practice_date BETWEEN '2099-06-01' AND '2099-06-05';

  RAISE NOTICE 'VALIDATION PASSED: acquire_or_get_listening_shared_story — ready+expired-lock reused untouched (1/2), generating+live-lock blocked (3), generating+expired-lock reacquired (4), failed reacquired (5)';
END $$;

DO $$
DECLARE
  v_anon_lss           BOOLEAN;
  v_auth_lss           BOOLEAN;
  v_anon_ulsp          BOOLEAN;
  v_auth_ulsp_excess   BOOLEAN;
  v_auth_ulsp_select   BOOLEAN;
  v_auth_ulsp_insert   BOOLEAN;
  v_auth_ulsp_update   BOOLEAN;
  v_anon_exec          BOOLEAN;
  v_auth_exec          BOOLEAN;
BEGIN
  v_anon_lss := has_table_privilege('anon', 'public.listening_shared_stories', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  v_auth_lss := has_table_privilege('authenticated', 'public.listening_shared_stories', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  IF v_anon_lss OR v_auth_lss THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon/authenticated still hold a privilege on listening_shared_stories (anon=%, authenticated=%)', v_anon_lss, v_auth_lss;
  END IF;

  v_anon_ulsp := has_table_privilege('anon', 'public.user_listening_shared_progress', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  IF v_anon_ulsp THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds a privilege on user_listening_shared_progress';
  END IF;

  v_auth_ulsp_excess := has_table_privilege('authenticated', 'public.user_listening_shared_progress', 'DELETE,TRUNCATE,REFERENCES,TRIGGER');
  IF v_auth_ulsp_excess THEN
    RAISE EXCEPTION 'VALIDATION FAILED: authenticated still holds an excess privilege (DELETE/TRUNCATE/REFERENCES/TRIGGER) on user_listening_shared_progress';
  END IF;

  v_auth_ulsp_select := has_table_privilege('authenticated', 'public.user_listening_shared_progress', 'SELECT');
  v_auth_ulsp_insert := has_table_privilege('authenticated', 'public.user_listening_shared_progress', 'INSERT');
  v_auth_ulsp_update := has_table_privilege('authenticated', 'public.user_listening_shared_progress', 'UPDATE');
  IF NOT (v_auth_ulsp_select AND v_auth_ulsp_insert AND v_auth_ulsp_update) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: authenticated is missing a privilege its own policies require (select=%, insert=%, update=%)', v_auth_ulsp_select, v_auth_ulsp_insert, v_auth_ulsp_update;
  END IF;

  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.user_listening_shared_progress'::regclass) <> 3 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected exactly 3 policies on user_listening_shared_progress (unchanged from creation)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_listening_shared_progress'::regclass) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on user_listening_shared_progress';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.listening_shared_stories'::regclass) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on listening_shared_stories';
  END IF;

  v_anon_exec := has_function_privilege('anon', 'public.acquire_or_get_listening_shared_story(text,text,date,integer)', 'EXECUTE');
  v_auth_exec := has_function_privilege('authenticated', 'public.acquire_or_get_listening_shared_story(text,text,date,integer)', 'EXECUTE');
  IF v_anon_exec OR v_auth_exec THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon/authenticated can EXECUTE acquire_or_get_listening_shared_story after CREATE OR REPLACE (anon=%, authenticated=%)', v_anon_exec, v_auth_exec;
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: anon has zero privileges on both tables and zero EXECUTE on the RPC; authenticated has zero on listening_shared_stories, exactly SELECT/INSERT/UPDATE on user_listening_shared_progress, and zero EXECUTE on the RPC; RLS + all 3 policies intact';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260724070000_fix_listening_shared_story_reacquire_and_grants
-- =============================================================================
