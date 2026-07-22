-- Disables preventive Listening inventory generation.
--
-- The shared level-group architecture (see
-- 20260722100000_create_listening_generation_jobs.sql and
-- src/services/listening/group-generation) generates content strictly on
-- demand: the first user of a level_group who needs a story with none
-- available for reuse triggers getOrCreateListeningGroupJob. There is no
-- longer any legitimate reason for a cron job to pre-generate stock ahead of
-- real demand — doing so would compete with the new jobs and could create
-- content nobody asked for.
--
-- This migration only unschedules the daily pg_cron trigger. The handler
-- code behind it (handleInventoryEnsure / the 'generate' action of
-- POST /api/internal/listening/supply, in
-- api/internal/listening/[...slug].ts) has been changed in the same deploy
-- to a safe no-op that creates nothing, so even a stray manual call with the
-- cron secret cannot resurrect preventive generation. Nothing else defined
-- by 20260715240000_create_listening_cron_jobs.sql (dispatch queue worker,
-- stuck-job repair) is touched — both remain legitimate: dispatch drains
-- whatever is already queued, repair now also recovers stuck
-- listening_generation_jobs rows (see recoverStuckListeningGroupJobs).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'listening-ensure-inventory') THEN
    PERFORM cron.unschedule('listening-ensure-inventory');
  END IF;
END $$;

-- Function is left in place (REVOKEd from PUBLIC already, SECURITY DEFINER,
-- harmless if ever invoked manually since the HTTP handler it calls is now a
-- no-op) rather than dropped, so a rollback of this migration alone
-- (re-adding the cron.schedule call) would not also require recreating the
-- function definition.
COMMENT ON FUNCTION public.listening_cron_ensure_inventory() IS
  'UNSCHEDULED as of 20260722110000: preventive stock generation was replaced by on-demand shared level_group generation. The HTTP endpoint this called (POST /api/internal/listening/supply {"action":"generate"}) is now a no-op. Kept only for cron.unschedule/rollback symmetry with 20260715240000_create_listening_cron_jobs.sql.';
