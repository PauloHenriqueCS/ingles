-- =============================================================================
-- Fix the infra "disk" signal.
--
-- The original 'disk' scope (20260831140000) read node_filesystem for
-- mountpoint="/" — the INSTANCE ROOT filesystem (OS + Postgres binaries + WAL +
-- logs), which on a small managed VM is naturally ~80% full and barely moves. It
-- is NOT the user's data (pg_database_size ≈ 50 MB) and it sits just under the
-- 85% threshold, so any tiny OS fluctuation would fire a meaningless alert.
--
-- Fix:
--   * add a MEANINGFUL 'db_size' signal — pg_database_size vs the plan/disk
--     quota (matches the Dashboard's "Database size" and the real read-only-cap
--     risk), measured in-database (100% reliable);
--   * keep 'disk' (root fs) only as a high-threshold safety net (95%) for a
--     genuine WAL/log runaway, and re-label it in the app as "instance root".
-- =============================================================================

-- 1. Expose the logical database size (MB) from the in-DB stats function.
CREATE OR REPLACE FUNCTION public.get_infra_db_stats(p_now timestamptz DEFAULT now())
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT jsonb_build_object(
    'max_connections',    current_setting('max_connections')::int,
    'total_connections',  (SELECT count(*) FROM pg_stat_activity),
    'connections_pct',    round(100.0 * (SELECT count(*) FROM pg_stat_activity)
                                / NULLIF(current_setting('max_connections')::numeric, 0), 1),
    'active_connections', (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
    'waiting_on_lock',    (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'),
    'longest_tx_seconds', COALESCE((
        SELECT round(EXTRACT(epoch FROM (p_now - min(xact_start))))::int
          FROM pg_stat_activity
         WHERE xact_start IS NOT NULL
           AND state <> 'idle'
           AND backend_type = 'client backend'
      ), 0),
    'db_size_mb',         round(pg_database_size(current_database()) / 1024.0 / 1024.0, 1)
  );
$fn$;

-- 2. Root-fs disk is a safety net only → raise its threshold well above the
--    static ~80% baseline so only a genuine fill fires.
UPDATE public.ai_alert_rules
   SET threshold_value = 95, updated_at = now()
 WHERE alert_type = 'resource_saturation' AND scope = 'disk';

-- 3. Seed the meaningful db_size rule (MB vs the plan cap). Default 450 MB warns
--    ~90% of the 500 MB free-plan database cap seen in the Dashboard; if this
--    environment is on a larger plan, raise threshold_value with no deploy.
INSERT INTO public.ai_alert_rules
  (environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
SELECT v.environment, v.alert_type, v.scope, v.window_seconds, v.threshold_value, v.min_event_count, v.severity, v.active, v.cooldown_seconds, v.created_by
FROM (VALUES
  ('production', 'resource_saturation', 'db_size', 300, 450::numeric, 1, 'warning', true, 3600, NULL::uuid),
  ('staging',    'resource_saturation', 'db_size', 300, 450::numeric, 1, 'warning', true, 3600, NULL::uuid)
) AS v(environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_alert_rules r
   WHERE r.environment = v.environment AND r.alert_type = v.alert_type AND r.scope = v.scope
);
