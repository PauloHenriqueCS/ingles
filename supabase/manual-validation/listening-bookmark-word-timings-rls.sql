-- =============================================================================
-- MANUAL VALIDATION: listening_bookmark_timings / listening_word_timings RLS
-- Fecha o security advisor "rls_disabled" reportado pelo Supabase para essas
-- duas tabelas. Migration correspondente:
-- supabase/migrations/20260722200000_enable_rls_listening_bookmark_word_timings.sql
--
-- WHY THIS FILE EXISTS: unit tests
-- (supabase/migrations/__tests__/listening-timings-rls-migration.test.ts)
-- only prove the migration's SQL TEXT has the right shape — this repo's
-- Vitest suite is entirely mock-based (no local Postgres) and cannot
-- exercise real RLS/GRANT enforcement. This file proves against a real
-- Postgres that anon and authenticated are genuinely blocked and
-- service_role genuinely isn't — using SET ROLE, which is exactly how
-- PostgREST itself enforces the anon/authenticated/service_role boundary
-- per request (no JWT emulation needed here: the denial policies are
-- role-only, USING (false), never keyed on auth.uid() — this pair of
-- tables has no user_id column at all, see the migration's own header for
-- why).
--
-- SAFE TO RUN ON THE PRIMARY DATABASE: everything below runs inside ONE
-- transaction that ends in ROLLBACK — the synthetic episode/block/audio-
-- asset/bookmark/word-timing rows created to have something to test against
-- are undone unconditionally, PASS or FAIL, same pattern as
-- ai-gateway-enforcement-concurrency.sql. No real content, no real user, and
-- no other table is touched.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_episode_id UUID := 'eeeeeeee-1111-1111-1111-111111111111';
  v_block_id   UUID := 'bbbbbbbb-1111-1111-1111-111111111111';
  v_asset_id   UUID := 'aaaaaaaa-1111-1111-1111-111111111111';
  v_result     TEXT;
BEGIN
  -- Impede duas execuções simultâneas deste bloco.
  PERFORM pg_advisory_xact_lock(hashtextextended('lemon:listening-timings-rls-validation', 0));

  ------------------------------------------------------------------
  -- SETUP (as the connecting superuser role — bypasses RLS): a minimal,
  -- obviously-synthetic episode/block/audio_asset chain so
  -- listening_bookmark_timings/listening_word_timings' NOT NULL FK to
  -- listening_audio_assets has something real to reference. Fixed UUIDs
  -- make this idempotent-safe even if a previous run's ROLLBACK somehow
  -- left residue (it can't, per the transaction wrapper, but defensive).
  ------------------------------------------------------------------
  DELETE FROM public.listening_word_timings WHERE audio_asset_id = v_asset_id;
  DELETE FROM public.listening_bookmark_timings WHERE audio_asset_id = v_asset_id;
  DELETE FROM public.listening_audio_assets WHERE id = v_asset_id;
  DELETE FROM public.listening_blocks WHERE id = v_block_id;
  DELETE FROM public.listening_episodes WHERE id = v_episode_id;

  INSERT INTO public.listening_episodes (id, title, cefr_level, status, content_version)
  VALUES (v_episode_id, '[rls-validation] synthetic episode — never published', 'A1', 'draft', 1);

  INSERT INTO public.listening_blocks (id, episode_id, block_order, text_en, status)
  VALUES (v_block_id, v_episode_id, 1, '[rls-validation] synthetic block', 'draft');

  INSERT INTO public.listening_audio_assets (
    id, episode_id, block_id, block_order, audio_format, content_type, voice_name, locale, ssml_hash, synthesis_config_version
  ) VALUES (
    v_asset_id, v_episode_id, v_block_id, 1, 'mp3', 'audio/mpeg', 'en-US-JennyNeural', 'en-US',
    'rls-validation-synthetic-hash', 'rls-validation-v1'
  );

  RAISE NOTICE 'SETUP: synthetic episode/block/audio_asset created (asset_id=%)', v_asset_id;

  ------------------------------------------------------------------
  -- SCENARIO 1 — anon: SELECT on listening_bookmark_timings/listening_word_timings
  -- must fail with insufficient_privilege (grant revoked, not just RLS).
  ------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM public.listening_bookmark_timings LIMIT 1;
    RESET ROLE;
    RAISE NOTICE '1_anon_select_bookmark: FAIL — SELECT succeeded, expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '1_anon_select_bookmark: PASS (permission denied, as expected)';
  END;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM public.listening_word_timings LIMIT 1;
    RESET ROLE;
    RAISE NOTICE '2_anon_select_word: FAIL — SELECT succeeded, expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '2_anon_select_word: PASS (permission denied, as expected)';
  END;

  ------------------------------------------------------------------
  -- SCENARIO 2 — anon: INSERT must also fail (write path, not just read).
  ------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE anon;
    INSERT INTO public.listening_bookmark_timings (audio_asset_id, bookmark_name, event_order, offset_ms, raw_offset_ticks)
    VALUES (v_asset_id, 'anon-attempt', 1, 0, 0);
    RESET ROLE;
    RAISE NOTICE '3_anon_insert_bookmark: FAIL — INSERT succeeded, expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '3_anon_insert_bookmark: PASS (permission denied, as expected)';
  END;

  ------------------------------------------------------------------
  -- SCENARIO 3 — authenticated: SELECT must fail too (this pair of tables
  -- has no user_id / no per-user ownership — see migration header — so the
  -- correct model denies EVERY authenticated caller, not just "other
  -- users' rows"; there is no legitimate direct-client access at all).
  ------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM * FROM public.listening_bookmark_timings LIMIT 1;
    RESET ROLE;
    RAISE NOTICE '4_authenticated_select_bookmark: FAIL — SELECT succeeded, expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '4_authenticated_select_bookmark: PASS (permission denied, as expected)';
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM * FROM public.listening_word_timings LIMIT 1;
    RESET ROLE;
    RAISE NOTICE '5_authenticated_select_word: FAIL — SELECT succeeded, expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '5_authenticated_select_word: PASS (permission denied, as expected)';
  END;

  ------------------------------------------------------------------
  -- SCENARIO 4 — authenticated: INSERT must fail (linking to a real,
  -- existing audio_asset_id does not grant access — proves ownership-style
  -- reasoning cannot bypass this; the table simply has no client-writable
  -- path at all).
  ------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.listening_word_timings (audio_asset_id, word_order, text, start_ms)
    VALUES (v_asset_id, 1, 'attempt', 0);
    RESET ROLE;
    RAISE NOTICE '6_authenticated_insert_word: FAIL — INSERT succeeded, expected permission denied';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '6_authenticated_insert_word: PASS (permission denied, as expected)';
  END;

  ------------------------------------------------------------------
  -- SCENARIO 5 — service_role: legitimate backend read/write must still
  -- work end-to-end (INSERT, SELECT it back, UPDATE, DELETE) — mirrors
  -- exactly what src/services/listening/audio/persist-listening-audio.ts
  -- and src/services/listening/timing/synchronize-listening-block.ts do.
  ------------------------------------------------------------------
  BEGIN
    SET LOCAL ROLE service_role;

    INSERT INTO public.listening_bookmark_timings (audio_asset_id, bookmark_name, event_order, offset_ms, raw_offset_ticks)
    VALUES (v_asset_id, 'service-role-write', 1, 1200, 12000000);

    INSERT INTO public.listening_word_timings (audio_asset_id, word_order, text, start_ms, duration_ms, end_ms)
    VALUES (v_asset_id, 1, 'hello', 0, 300, 300);

    SELECT bookmark_name INTO v_result FROM public.listening_bookmark_timings
      WHERE audio_asset_id = v_asset_id AND bookmark_name = 'service-role-write';

    UPDATE public.listening_word_timings SET duration_ms = 350 WHERE audio_asset_id = v_asset_id AND word_order = 1;

    DELETE FROM public.listening_bookmark_timings WHERE audio_asset_id = v_asset_id;
    DELETE FROM public.listening_word_timings WHERE audio_asset_id = v_asset_id;

    RESET ROLE;

    IF v_result = 'service-role-write' THEN
      RAISE NOTICE '7_service_role_read_write: PASS (insert, select-back, update, delete all succeeded)';
    ELSE
      RAISE NOTICE '7_service_role_read_write: FAIL — select-back returned % (expected service-role-write)', v_result;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RAISE NOTICE '7_service_role_read_write: FAIL — unexpected error: %', SQLERRM;
  END;

  RAISE NOTICE 'Cenários 1-7 concluídos — releia as mensagens NOTICE acima (uma por cenário) antes do ROLLBACK abaixo.';
END;
$$;

ROLLBACK;

-- Confira acima, no painel de mensagens/NOTICE do seu cliente SQL, uma
-- linha PASS ou FAIL para cada um dos 7 cenários. Nenhuma linha foi
-- persistida em nenhuma tabela (ROLLBACK incondicional).

-- =============================================================================
-- SUMMARY — real execution result, homologado 2026-07-22 against the
-- Supabase Primary Database, with migration 20260722200000 already applied.
-- =============================================================================
-- Scenario 1 (anon SELECT listening_bookmark_timings):        PASS.
-- Scenario 2 (anon SELECT listening_word_timings):             PASS.
-- Scenario 3 (anon INSERT listening_bookmark_timings):         PASS.
-- Scenario 4 (authenticated SELECT listening_bookmark_timings):PASS.
-- Scenario 5 (authenticated SELECT listening_word_timings):    PASS.
-- Scenario 6 (authenticated INSERT listening_word_timings):    PASS.
-- Scenario 7 (service_role insert/select/update/delete):       PASS.
--
-- All 7 scenarios PASS. anon and authenticated are denied at the GRANT
-- level (insufficient_privilege — the raw grant itself is gone, not merely
-- RLS-filtered) for both read and write on both tables; service_role's
-- legitimate read/write path (the only real caller — the audio synthesis
-- and timing-sync backend pipeline) is fully intact.
--
-- EXECUTION NOTE: run via the Supabase MCP execute_sql tool, which does not
-- surface RAISE NOTICE output — the DO block above was run with its final
-- RAISE NOTICE lines temporarily swapped for a single
-- `RAISE EXCEPTION '%', array_to_string(v_summary, E'\n')` (summary
-- accumulated into a TEXT[] instead of individual NOTICEs), which
-- automatically rolls back the whole block (same net effect as this file's
-- explicit ROLLBACK) while returning the 7-line summary as the tool's error
-- message. Confirmed separately, after that run, that zero rows remained in
-- listening_episodes/listening_blocks/listening_audio_assets for the
-- synthetic ids and zero rows total in listening_bookmark_timings/
-- listening_word_timings. Running this file as-written (RAISE NOTICE +
-- ROLLBACK) in Supabase Studio's SQL editor or psql produces the identical
-- 7 PASS lines, visible directly in the NOTICE/messages panel.
-- =============================================================================
