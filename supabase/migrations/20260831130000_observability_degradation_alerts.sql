-- =============================================================================
-- Observability degradation alerts (DB / API latency + HTTP 5xx) + log retention
-- -----------------------------------------------------------------------------
-- Extends the EXISTING operational-alerts machinery (ai_alerts / ai_alert_rules,
-- see 20260812230000_operational_alerts.sql) to a NEW class of signal:
-- performance degradation observed in public.debug_request_logs — the same table
-- through which a real DB slowdown was caught by hand. Nothing here is a new
-- schema: it reuses the alert lifecycle, dedup index, cooldown and the Resend
-- e-mail transport already wired in api/_ai-gateway/alerts.ts.
--
-- What it adds:
--   * rule-driven latency (latency_p95) and HTTP-error (error_rate/http_5xx)
--     alert rules for production + staging (data-driven thresholds — tune them
--     in ai_alert_rules with NO deploy);
--   * one atomic sweep RPC (run_observability_alert_sweep) that BOTH opens and
--     recovers these incidents from debug_request_logs, dedup/cooldown-safe;
--   * a pg_net cron entry point (observability_alerts_cron_sweep) mirroring
--     alerts_cron_recovery_sweep — documented, NOT auto-scheduled (same baseline
--     convention; scheduled out-of-schema after deploy);
--   * a 15-day retention cleanup for debug_request_logs;
--   * production debug logging forced ON (level=debug, 100% sample) so the
--     detector always has a signal.
--
-- Isolation: these alerts NEVER set ai_alerts.provider (it stays NULL), so the
-- provider recovery sweep (runRecoverySweep) — now filtered to provider IS NOT
-- NULL — and this sweep can never touch each other's incidents.
--
-- Reads ONLY sanitized telemetry (debug_request_logs stores no PII / audio /
-- tokens / prompt / reference text — see 20260828120000_debug_observability_
-- logging.sql). The e-mail carries only structured numeric fields.
-- =============================================================================

-- 1. Per-scope metric helper. Given a scope + window, returns the sample count
--    and the p95 (latency scopes) or the raw event count (http_5xx). Kept as a
--    single function so the open and recover paths can never disagree on how a
--    metric is computed. STABLE (reads a table) + SECURITY DEFINER (the sweep
--    runs as service_role; debug_request_logs is service_role-only).
CREATE OR REPLACE FUNCTION public._observability_metric(
  p_environment    text,
  p_scope          text,
  p_window_seconds integer,
  p_now            timestamptz
) RETURNS TABLE (sample_count integer, metric_value numeric)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_scope = 'db_latency' THEN
    RETURN QUERY
      SELECT count(*)::int,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY d.db_ms)::numeric
        FROM public.debug_request_logs d
       WHERE d.environment = p_environment
         AND d.db_ms IS NOT NULL
         AND d.created_at >= p_now - make_interval(secs => p_window_seconds);

  ELSIF p_scope = 'api_latency' THEN
    -- Server-side full-request duration. Populated once the per-request tracer
    -- (api/_debug-log.ts startTrace → finish() emits stage='total') is wired
    -- into routes; until then this simply finds 0 samples and never fires.
    RETURN QUERY
      SELECT count(*)::int,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY d.duration_ms)::numeric
        FROM public.debug_request_logs d
       WHERE d.environment = p_environment
         AND d.surface = 'server'
         AND d.stage = 'total'
         AND d.duration_ms IS NOT NULL
         AND d.created_at >= p_now - make_interval(secs => p_window_seconds);

  ELSIF p_scope = 'client_latency' THEN
    RETURN QUERY
      SELECT count(*)::int,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY d.duration_ms)::numeric
        FROM public.debug_request_logs d
       WHERE d.environment = p_environment
         AND d.surface = 'client'
         AND d.duration_ms IS NOT NULL
         AND d.created_at >= p_now - make_interval(secs => p_window_seconds);

  ELSIF p_scope = 'http_5xx' THEN
    -- Count of 5xx responses observed (server or client surface). metric_value
    -- IS the count so the caller can treat it uniformly.
    RETURN QUERY
      SELECT count(*) FILTER (WHERE d.status_code >= 500)::int,
             count(*) FILTER (WHERE d.status_code >= 500)::numeric
        FROM public.debug_request_logs d
       WHERE d.environment = p_environment
         AND d.created_at >= p_now - make_interval(secs => p_window_seconds);

  ELSE
    -- Unknown scope → no samples (never fires). Never raises.
    sample_count := 0; metric_value := NULL; RETURN NEXT;
  END IF;
END;
$fn$;

-- 2. The sweep. One call detects (opens/increments) AND recovers every
--    observability incident for an environment, atomically per incident via the
--    existing partial unique index idx_alerts_dedup_active. Returns the alerts
--    that need an OPEN e-mail and those that just RECOVERED so the cron route
--    (api/_ai-gateway/alerts.ts runObservabilitySweep) can dispatch e-mail
--    exactly like the provider pipeline. Never sends e-mail itself.
CREATE OR REPLACE FUNCTION public.run_observability_alert_sweep(
  p_environment             text,
  p_now                     timestamptz DEFAULT now(),
  p_orphan_max_open_seconds integer     DEFAULT 21600  -- 6h no-signal → quiet close
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_rule          record;
  v_sample        integer;
  v_value         numeric;
  v_threshold     numeric;
  v_is_latency    boolean;
  v_breach        boolean;
  v_recovered_ok  boolean;
  v_severity      text;
  v_dedup_key     text;
  v_title         text;
  v_detail        jsonb;
  v_metric_name   text;
  v_active        record;
  v_last_notified timestamptz;
  v_cooldown_ok   boolean;
  v_alert_id      uuid;
  v_was_inserted  boolean;
  v_opened        jsonb := '[]'::jsonb;
  v_recovered     jsonb := '[]'::jsonb;
BEGIN
  FOR v_rule IN
    SELECT * FROM public.ai_alert_rules
     WHERE environment = p_environment
       AND active
       AND (alert_type = 'latency_p95'
            OR (alert_type = 'error_rate' AND scope = 'http_5xx'))
  LOOP
    v_is_latency := (v_rule.alert_type = 'latency_p95');

    SELECT m.sample_count, m.metric_value
      INTO v_sample, v_value
      FROM public._observability_metric(p_environment, v_rule.scope, v_rule.window_seconds, p_now) m;

    v_sample    := COALESCE(v_sample, 0);
    v_threshold := v_rule.threshold_value;
    v_dedup_key := p_environment || ':' || v_rule.alert_type || ':' || v_rule.scope;

    IF v_is_latency THEN
      v_metric_name := 'p95_' || v_rule.scope;
      -- Need enough samples to trust a percentile AND the p95 over threshold.
      v_breach := v_sample >= v_rule.min_event_count
                  AND v_value IS NOT NULL
                  AND v_threshold IS NOT NULL
                  AND v_value >= v_threshold;
      -- Recovered = enough traffic to judge AND p95 back under threshold.
      v_recovered_ok := v_sample >= v_rule.min_event_count
                        AND v_value IS NOT NULL
                        AND v_threshold IS NOT NULL
                        AND v_value < v_threshold;
      -- Dynamic escalation: a p95 far past the threshold is critical even if the
      -- rule's baseline severity is only "warning".
      v_severity := v_rule.severity;
      IF v_breach AND v_threshold > 0 AND v_value >= v_threshold * 2.5 THEN
        v_severity := 'critical';
      END IF;
      v_title := CASE v_rule.scope
                   WHEN 'db_latency'     THEN 'DB latency degraded'
                   WHEN 'api_latency'    THEN 'API latency degraded'
                   WHEN 'client_latency' THEN 'Client latency degraded'
                   ELSE 'Latency degraded (' || v_rule.scope || ')'
                 END || ' — p95 ' || COALESCE(round(v_value)::text, 'n/a') || 'ms';
    ELSE
      -- http_5xx: metric_value IS the 5xx count in the window.
      v_metric_name := 'http_5xx_count';
      v_breach := v_value >= v_rule.min_event_count;
      v_recovered_ok := (v_value = 0);   -- no 5xx in the window → recovered
      v_severity := v_rule.severity;
      v_title := 'HTTP 5xx spike — ' || COALESCE(v_value::text, '0') || ' in '
                 || v_rule.window_seconds || 's';
    END IF;

    v_detail := jsonb_build_object(
      'metric',         v_metric_name,
      'scope',          v_rule.scope,
      'value',          v_value,
      'threshold',      v_threshold,
      'sample_count',   v_sample,
      'window_seconds', v_rule.window_seconds,
      'min_event_count', v_rule.min_event_count
    );

    -- ── BREACH ────────────────────────────────────────────────────────────────
    IF v_breach THEN
      SELECT id, severity INTO v_active
        FROM public.ai_alerts
       WHERE dedup_key = v_dedup_key AND environment = p_environment AND status <> 'resolved'
       LIMIT 1;

      IF FOUND THEN
        -- Already open → increment; escalate severity if it worsened. No e-mail.
        UPDATE public.ai_alerts
           SET occurrence_count = occurrence_count + 1,
               last_occurrence  = p_now,
               detail           = v_detail,
               severity         = CASE WHEN v_severity = 'critical' THEN 'critical' ELSE severity END,
               title            = v_title,
               updated_at       = now()
         WHERE id = v_active.id;
        CONTINUE;
      END IF;

      -- No open incident → cooldown check vs the most recent notification.
      SELECT max(last_notified_at) INTO v_last_notified
        FROM public.ai_alerts
       WHERE dedup_key = v_dedup_key AND environment = p_environment;

      v_cooldown_ok := v_last_notified IS NULL
                    OR p_now - v_last_notified >= make_interval(secs => v_rule.cooldown_seconds);

      INSERT INTO public.ai_alerts (
        environment, rule_id, alert_type, scope, provider, error_class, severity,
        status, title, detail, dedup_key,
        occurrence_count, first_occurrence, last_occurrence, opened_at, last_notified_at
      ) VALUES (
        p_environment, v_rule.id, v_rule.alert_type, v_rule.scope, NULL, NULL, v_severity,
        'open', v_title, v_detail, v_dedup_key,
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
        v_opened := v_opened || jsonb_build_object(
          'alert_id',   v_alert_id,
          'dedup_key',  v_dedup_key,
          'alert_type', v_rule.alert_type,
          'scope',      v_rule.scope,
          'severity',   v_severity,
          'title',      v_title,
          'detail',     v_detail,
          'opened_at',  p_now
        );
      END IF;

    -- ── NO BREACH → maybe recover / orphan-close an open incident ─────────────
    ELSE
      SELECT * INTO v_active
        FROM public.ai_alerts
       WHERE dedup_key = v_dedup_key AND environment = p_environment AND status = 'open'
       FOR UPDATE
       LIMIT 1;

      IF FOUND THEN
        IF v_recovered_ok THEN
          UPDATE public.ai_alerts
             SET status = 'resolved', resolved_at = p_now,
                 resolve_reason = 'auto_recovered', detail = v_detail, updated_at = now()
           WHERE id = v_active.id AND status = 'open';

          v_recovered := v_recovered || jsonb_build_object(
            'alert_id',         v_active.id,
            'dedup_key',        v_dedup_key,
            'alert_type',       v_active.alert_type,
            'scope',            v_active.scope,
            'severity',         v_active.severity,
            'title',            v_active.title,
            'occurrence_count', v_active.occurrence_count,
            'opened_at',        v_active.opened_at,
            'first_occurrence', v_active.first_occurrence,
            'last_occurrence',  v_active.last_occurrence,
            'resolved_at',      p_now,
            'detail',           v_detail
          );
        ELSIF v_active.opened_at IS NOT NULL
              AND p_now - v_active.opened_at >= make_interval(secs => p_orphan_max_open_seconds) THEN
          -- No signal for a long time (e.g. traffic dried up) → quiet close.
          UPDATE public.ai_alerts
             SET status = 'resolved', resolved_at = p_now,
                 resolve_reason = 'auto_closed_stale', updated_at = now()
           WHERE id = v_active.id AND status = 'open';
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('opened', v_opened, 'recovered', v_recovered);
END;
$fn$;

-- 3. pg_net cron entry point. Mirrors alerts_cron_recovery_sweep exactly (Vault
--    cron_secret + app_base_url, Authorization: Bearer) but hits the new route.
--    NOT auto-scheduled here — same convention as the baseline. Reference:
--
--      SELECT cron.schedule(
--        'observability-alerts-sweep',
--        '*/5 * * * *',
--        $$SELECT public.observability_alerts_cron_sweep()$$
--      );
CREATE OR REPLACE FUNCTION public.observability_alerts_cron_sweep()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_secret text;
  v_url    text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'observability_alerts_cron_sweep: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'observability_alerts_cron_sweep: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/observability-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$fn$;

-- 4. Retention: delete debug_request_logs older than N days (default 15). Pure
--    DB, no secrets — safe to schedule directly. Reference:
--
--      SELECT cron.schedule(
--        'debug-logs-retention-cleanup',
--        '30 3 * * *',
--        $$SELECT public.cleanup_debug_request_logs()$$
--      );
CREATE OR REPLACE FUNCTION public.cleanup_debug_request_logs(
  p_retention_days integer DEFAULT 15
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.debug_request_logs
   WHERE created_at < now() - make_interval(days => p_retention_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

-- 5. Seed the rules for production + homologation (staging). Idempotent via NOT
--    EXISTS (matches the operational-alerts seed convention). created_by NULL =
--    system-owned. Thresholds are DATA-DRIVEN — change them in ai_alert_rules
--    with no deploy. Baselines below come from real production p95 history
--    (normal DB p95 ≈ 200-450ms; a real incident hit p95 3.5-6.5s).
INSERT INTO public.ai_alert_rules
  (environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
SELECT v.environment, v.alert_type, v.scope, v.window_seconds, v.threshold_value, v.min_event_count, v.severity, v.active, v.cooldown_seconds, v.created_by
FROM (VALUES
  -- environment, alert_type,    scope,            window, threshold,        min_events, severity,  active, cooldown, created_by
  ('production', 'latency_p95', 'db_latency',       3600, 1500::numeric,     15, 'warning', true, 1800, NULL::uuid),
  ('production', 'latency_p95', 'api_latency',      3600, 5000::numeric,     15, 'warning', true, 1800, NULL::uuid),
  ('production', 'latency_p95', 'client_latency',   3600, 8000::numeric,     20, 'info',    true, 3600, NULL::uuid),
  ('production', 'error_rate',  'http_5xx',          900, NULL::numeric,      3, 'warning', true, 1800, NULL::uuid),
  ('staging',    'latency_p95', 'db_latency',       3600, 1500::numeric,     15, 'warning', true, 1800, NULL::uuid),
  ('staging',    'latency_p95', 'api_latency',      3600, 5000::numeric,     15, 'warning', true, 1800, NULL::uuid),
  ('staging',    'latency_p95', 'client_latency',   3600, 8000::numeric,     20, 'info',    true, 3600, NULL::uuid),
  ('staging',    'error_rate',  'http_5xx',          900, NULL::numeric,      3, 'warning', true, 1800, NULL::uuid)
) AS v(environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_alert_rules r
   WHERE r.environment = v.environment
     AND r.alert_type  = v.alert_type
     AND r.scope       = v.scope
);

-- 6. Keep production debug logging ON so the detector always has a signal
--    (level=debug, 100% sample, no auto-off). Retention (step 4) bounds growth.
--    Only production is forced on; staging/development are left as-is.
UPDATE public.app_debug_logging_config
   SET level = 'debug', sample_rate = 100, auto_off_at = NULL, updated_at = now()
 WHERE environment = 'production';

-- 7. Grants — backend-only (service_role); nothing exposed to anon/authenticated.
REVOKE ALL ON FUNCTION public._observability_metric(text, text, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_observability_alert_sweep(text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.observability_alerts_cron_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_debug_request_logs(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public._observability_metric(text, text, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_observability_alert_sweep(text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.observability_alerts_cron_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_debug_request_logs(integer) TO service_role;
