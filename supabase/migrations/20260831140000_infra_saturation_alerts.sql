-- =============================================================================
-- Infrastructure saturation alerts (DB connections / locks / long tx + CPU / RAM
-- / disk) — the "infra" tier that complements the app-latency degradation alerts
-- (20260831130000). Same ai_alerts pipeline, dedup index, cooldown and Resend
-- e-mail; incidents leave provider NULL so the provider recovery sweep never
-- touches them.
--
-- Two signal sources:
--   * IN-DATABASE (100% reliable, no external dependency): connection %,
--     lock-waiters and longest running transaction, from pg_stat_activity.
--   * FROM THE SUPABASE METRICS ENDPOINT (best-effort): CPU / memory / disk.
--     Parsed server-side in api/_ai-gateway/alerts.ts (runInfraSweep) using the
--     credentials already in Vercel, and fed here via raise_observability_alert.
--
-- All thresholds are DATA-DRIVEN in ai_alert_rules (tune with NO deploy). CPU is
-- computed as utilisation between two sweeps from the node_cpu_seconds_total
-- counter (a single scrape can't give instantaneous CPU%), using
-- infra_metric_samples + record_cpu_sample_and_get_util.
-- =============================================================================

-- 1. Allow a new alert_type. The CHECK must be re-stated in full (add only
--    'resource_saturation'); every previously-allowed value is preserved.
ALTER TABLE public.ai_alert_rules DROP CONSTRAINT ai_alert_rules_alert_type_check;
ALTER TABLE public.ai_alert_rules ADD CONSTRAINT ai_alert_rules_alert_type_check
  CHECK (alert_type = ANY (ARRAY[
    'budget_threshold','cost_anomaly','call_spike','error_rate','latency_p95',
    'block_rate','retry_rate','unpriced_events','unknown_feature','gateway_offline',
    'config_unacknowledged','version_drift','resource_saturation'
  ]));

-- 2. In-database infra stats (connection saturation, lock waiters, longest tx).
--    SECURITY DEFINER so it sees ALL sessions in pg_stat_activity.
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
      ), 0)
  );
$fn$;

-- 3. CPU sample store: node_cpu_seconds_total is a COUNTER, so utilisation needs
--    two scrapes. This keeps the last (idle,total) per environment and returns
--    the utilisation % over the interval; NULL on the first sample or a counter
--    reset (never a bogus negative/huge value).
CREATE TABLE IF NOT EXISTS public.infra_metric_samples (
  environment       text PRIMARY KEY,
  cpu_idle_seconds  numeric,
  cpu_total_seconds numeric,
  sampled_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.infra_metric_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.infra_metric_samples FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_cpu_sample_and_get_util(
  p_environment text,
  p_idle        numeric,
  p_total       numeric,
  p_now         timestamptz DEFAULT now()
) RETURNS numeric
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_prev   public.infra_metric_samples;
  v_didle  numeric;
  v_dtotal numeric;
  v_util   numeric := NULL;
BEGIN
  SELECT * INTO v_prev FROM public.infra_metric_samples WHERE environment = p_environment;

  IF FOUND AND p_idle >= v_prev.cpu_idle_seconds AND p_total > v_prev.cpu_total_seconds THEN
    v_didle  := p_idle  - v_prev.cpu_idle_seconds;
    v_dtotal := p_total - v_prev.cpu_total_seconds;
    IF v_dtotal > 0 THEN
      v_util := round(100.0 * (1 - (v_didle / v_dtotal)), 1);
      IF v_util < 0 THEN v_util := 0; END IF;
      IF v_util > 100 THEN v_util := 100; END IF;
    END IF;
  END IF;

  INSERT INTO public.infra_metric_samples (environment, cpu_idle_seconds, cpu_total_seconds, sampled_at)
  VALUES (p_environment, p_idle, p_total, p_now)
  ON CONFLICT (environment) DO UPDATE
    SET cpu_idle_seconds = EXCLUDED.cpu_idle_seconds,
        cpu_total_seconds = EXCLUDED.cpu_total_seconds,
        sampled_at = EXCLUDED.sampled_at;

  RETURN v_util;  -- NULL on first sample / counter reset → caller skips CPU this tick
END;
$fn$;

-- 4. Generic gauge alert: raise / increment / recover / orphan-close for an
--    externally-measured value against its configured rule. Mirrors the open/
--    recover logic of run_observability_alert_sweep but for a value the CALLER
--    already measured (CPU%, memory%, connection%, lock count, …). Reuses the
--    same partial unique dedup index and cooldown. Returns opened/recovered
--    payloads (or nulls) for the caller to e-mail.
CREATE OR REPLACE FUNCTION public.raise_observability_alert(
  p_environment             text,
  p_alert_type              text,
  p_scope                   text,
  p_value                   numeric,
  p_title                   text,
  p_detail                  jsonb,
  p_now                     timestamptz DEFAULT now(),
  p_orphan_max_open_seconds integer     DEFAULT 21600
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_rule          record;
  v_threshold     numeric;
  v_severity      text;
  v_breach        boolean;
  v_dedup_key     text;
  v_active        record;
  v_last_notified timestamptz;
  v_cooldown_ok   boolean;
  v_alert_id      uuid;
  v_was_inserted  boolean;
  v_opened        jsonb := 'null'::jsonb;
  v_recovered     jsonb := 'null'::jsonb;
BEGIN
  SELECT * INTO v_rule
    FROM public.ai_alert_rules
   WHERE environment = p_environment AND alert_type = p_alert_type AND scope = p_scope AND active
   ORDER BY updated_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'no_rule', 'opened', v_opened, 'recovered', v_recovered);
  END IF;

  v_threshold := v_rule.threshold_value;
  v_severity  := v_rule.severity;
  v_dedup_key := p_environment || ':' || p_alert_type || ':' || p_scope;
  v_breach    := p_value IS NOT NULL AND v_threshold IS NOT NULL AND p_value >= v_threshold;

  IF v_breach THEN
    SELECT id INTO v_active
      FROM public.ai_alerts
     WHERE dedup_key = v_dedup_key AND environment = p_environment AND status <> 'resolved'
     LIMIT 1;

    IF FOUND THEN
      UPDATE public.ai_alerts
         SET occurrence_count = occurrence_count + 1, last_occurrence = p_now,
             detail = p_detail, title = p_title, updated_at = now()
       WHERE id = v_active.id;
      RETURN jsonb_build_object('action', 'incremented', 'opened', v_opened, 'recovered', v_recovered);
    END IF;

    SELECT max(last_notified_at) INTO v_last_notified
      FROM public.ai_alerts WHERE dedup_key = v_dedup_key AND environment = p_environment;
    v_cooldown_ok := v_last_notified IS NULL
                  OR p_now - v_last_notified >= make_interval(secs => v_rule.cooldown_seconds);

    INSERT INTO public.ai_alerts (
      environment, rule_id, alert_type, scope, provider, error_class, severity,
      status, title, detail, dedup_key,
      occurrence_count, first_occurrence, last_occurrence, opened_at, last_notified_at
    ) VALUES (
      p_environment, v_rule.id, p_alert_type, p_scope, NULL, NULL, v_severity,
      'open', p_title, p_detail, v_dedup_key,
      1, p_now, p_now, p_now,
      CASE WHEN v_cooldown_ok THEN p_now ELSE NULL END
    )
    ON CONFLICT (dedup_key, environment) WHERE status <> 'resolved'
    DO UPDATE SET
      occurrence_count = ai_alerts.occurrence_count + 1,
      last_occurrence  = p_now,
      detail           = EXCLUDED.detail,
      updated_at       = now()
    RETURNING id, (xmax = 0) INTO v_alert_id, v_was_inserted;

    IF v_was_inserted AND v_cooldown_ok THEN
      v_opened := jsonb_build_object(
        'alert_id', v_alert_id, 'dedup_key', v_dedup_key,
        'alert_type', p_alert_type, 'scope', p_scope, 'severity', v_severity,
        'title', p_title, 'detail', p_detail, 'opened_at', p_now
      );
    END IF;

  ELSE
    -- Not breaching → recover an open incident (value back under threshold) or
    -- orphan-close a long-open one with no fresh signal.
    SELECT * INTO v_active
      FROM public.ai_alerts
     WHERE dedup_key = v_dedup_key AND environment = p_environment AND status = 'open'
     FOR UPDATE
     LIMIT 1;

    IF FOUND THEN
      IF p_value IS NOT NULL AND v_threshold IS NOT NULL AND p_value < v_threshold THEN
        UPDATE public.ai_alerts
           SET status = 'resolved', resolved_at = p_now,
               resolve_reason = 'auto_recovered', detail = p_detail, updated_at = now()
         WHERE id = v_active.id AND status = 'open';
        v_recovered := jsonb_build_object(
          'alert_id', v_active.id, 'dedup_key', v_dedup_key,
          'alert_type', p_alert_type, 'scope', p_scope, 'severity', v_active.severity,
          'title', v_active.title, 'occurrence_count', v_active.occurrence_count,
          'opened_at', v_active.opened_at, 'first_occurrence', v_active.first_occurrence,
          'last_occurrence', v_active.last_occurrence, 'resolved_at', p_now, 'detail', p_detail
        );
      ELSIF v_active.opened_at IS NOT NULL
            AND p_now - v_active.opened_at >= make_interval(secs => p_orphan_max_open_seconds) THEN
        UPDATE public.ai_alerts
           SET status = 'resolved', resolved_at = p_now,
               resolve_reason = 'auto_closed_stale', updated_at = now()
         WHERE id = v_active.id AND status = 'open';
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('opened', v_opened, 'recovered', v_recovered);
END;
$fn$;

-- 5. Seed resource_saturation rules (production + staging). window_seconds is
--    unused by the gauge path but the column is NOT NULL / CHECK > 0, so a
--    placeholder 300 is stored. threshold_value is the gauge threshold:
--      db_connections / memory / disk / cpu → percent; db_locks → count;
--      db_long_tx → seconds. CPU starts at 85% and is tuned from real data.
INSERT INTO public.ai_alert_rules
  (environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
SELECT v.environment, v.alert_type, v.scope, v.window_seconds, v.threshold_value, v.min_event_count, v.severity, v.active, v.cooldown_seconds, v.created_by
FROM (VALUES
  -- env,          type,                  scope,            window, threshold,      min, severity,   active, cooldown, created_by
  ('production', 'resource_saturation', 'db_connections',   300, 80::numeric,  1, 'warning', true, 1800, NULL::uuid),
  ('production', 'resource_saturation', 'db_locks',         300, 5::numeric,   1, 'warning', true, 1800, NULL::uuid),
  ('production', 'resource_saturation', 'db_long_tx',       300, 300::numeric, 1, 'warning', true, 1800, NULL::uuid),
  ('production', 'resource_saturation', 'cpu',              300, 85::numeric,  1, 'warning', true, 1800, NULL::uuid),
  ('production', 'resource_saturation', 'memory',           300, 90::numeric,  1, 'warning', true, 1800, NULL::uuid),
  ('production', 'resource_saturation', 'disk',             300, 85::numeric,  1, 'warning', true, 3600, NULL::uuid),
  ('staging',    'resource_saturation', 'db_connections',   300, 80::numeric,  1, 'warning', true, 1800, NULL::uuid),
  ('staging',    'resource_saturation', 'db_locks',         300, 5::numeric,   1, 'warning', true, 1800, NULL::uuid),
  ('staging',    'resource_saturation', 'db_long_tx',       300, 300::numeric, 1, 'warning', true, 1800, NULL::uuid),
  ('staging',    'resource_saturation', 'cpu',              300, 85::numeric,  1, 'warning', true, 1800, NULL::uuid),
  ('staging',    'resource_saturation', 'memory',           300, 90::numeric,  1, 'warning', true, 1800, NULL::uuid),
  ('staging',    'resource_saturation', 'disk',             300, 85::numeric,  1, 'warning', true, 3600, NULL::uuid)
) AS v(environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_alert_rules r
   WHERE r.environment = v.environment AND r.alert_type = v.alert_type AND r.scope = v.scope
);

-- 6. Grants — backend-only (service_role).
REVOKE ALL ON FUNCTION public.get_infra_db_stats(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cpu_sample_and_get_util(text, numeric, numeric, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.raise_observability_alert(text, text, text, numeric, text, jsonb, timestamptz, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_infra_db_stats(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_cpu_sample_and_get_util(text, numeric, numeric, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.raise_observability_alert(text, text, text, numeric, text, jsonb, timestamptz, integer) TO service_role;
