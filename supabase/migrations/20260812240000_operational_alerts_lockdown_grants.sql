-- =============================================================================
-- Corrective lockdown for the operational-alerts functions.
-- -----------------------------------------------------------------------------
-- 20260812230000 locked these functions with `REVOKE ALL ... FROM PUBLIC` +
-- `GRANT EXECUTE ... TO service_role`. That is sufficient only where nothing
-- ELSE grants execute. The production database has ALTER DEFAULT PRIVILEGES that
-- GRANT EXECUTE on new public functions to anon + authenticated (verified:
-- record_provider_incident came out anon/authenticated = true, unlike every
-- other internal function such as conversation_cron_sweep_stale_sessions /
-- reserve_gateway_usage_v1, which are service_role-only). Those explicit role
-- grants are NOT removed by a REVOKE FROM PUBLIC. Revoke them explicitly so the
-- SECURITY DEFINER incident functions can never be executed by end users
-- (anon/authenticated) — only the backend service_role. Idempotent and safe to
-- apply in every environment (homolog, where the grants were already absent,
-- included).
-- =============================================================================

REVOKE ALL ON FUNCTION public._ai_alert_status_matches_class(integer, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.record_provider_incident(text, text, text, text, text, text, jsonb, timestamptz) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_provider_incident_if_recovered(uuid, integer, integer, timestamptz) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.alerts_cron_recovery_sweep() FROM anon, authenticated;

-- Re-assert the intended backend-only grant (no-op where already present).
GRANT EXECUTE ON FUNCTION public._ai_alert_status_matches_class(integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_provider_incident(text, text, text, text, text, text, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_provider_incident_if_recovered(uuid, integer, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.alerts_cron_recovery_sweep() TO service_role;
