-- Fixes two advisor findings against the objects created in
-- 20260724050000_create_listening_shared_stories.sql — no schema/behavior
-- change beyond hardening these two things.

-- Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION; the
-- explicit GRANT ... TO service_role in the prior migration did not revoke
-- that default, leaving the RPC callable by anon/authenticated directly via
-- PostgREST (/rest/v1/rpc/...) — able to create/take over a shared-story
-- lock without going through the backend at all. Lock this down to
-- service_role only, matching the intended access model.
REVOKE EXECUTE ON FUNCTION acquire_or_get_listening_shared_story(TEXT, TEXT, DATE, INTEGER) FROM PUBLIC, anon, authenticated;

-- search_path hardening for the two trigger functions (no behavior change).
ALTER FUNCTION listening_shared_stories_set_updated_at() SET search_path = public;
ALTER FUNCTION user_listening_shared_progress_set_updated_at() SET search_path = public;
