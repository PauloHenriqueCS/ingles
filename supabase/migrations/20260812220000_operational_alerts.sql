-- =============================================================================
-- Operational alerts for external provider failures (OpenAI / Azure Speech / …)
-- -----------------------------------------------------------------------------
-- Reuses the EXISTING, previously-unwired ai_alert_rules / ai_alerts tables
-- rather than introducing a parallel schema. Backward-compatible and additive:
--   * only ADD COLUMN IF NOT EXISTS and one NOT NULL relaxation;
--   * two atomic RPCs so multiple concurrent Vercel instances converge on a
--     single "open" and a single "recovered" transition (dedup at the DB, never
--     only in memory);
--   * a pg_net cron function (documented, NOT auto-scheduled — same convention
--     as conversation_cron_sweep_stale_sessions in the baseline) for recovery /
--     backstop / orphan closure.
--
-- The alert pipeline reads ONLY already-sanitized telemetry (ai_usage_events,
-- written by the gateway's failEvent). No prompts / audio / tokens / keys ever
-- touch these tables or the email — see api/_ai-gateway/alerts.ts.
--
-- Environment values are constrained by the existing ai_alerts /
-- ai_alert_rules CHECK to development|staging|production. Homologation is
-- therefore stored as 'staging' (and merely LABELLED "HOMOLOG" in the email
-- subject by the app) — no new enum value, no constraint change.
-- =============================================================================

-- 1. Allow system-seeded rules that have no auth.users owner. Relaxation only
--    (existing rows keep their created_by); backward-compatible.
ALTER TABLE public.ai_alert_rules ALTER COLUMN created_by DROP NOT NULL;

-- 2. Incident-counting columns on ai_alerts (all nullable / defaulted →
--    backward-compatible with any existing rows).
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS provider          text;
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS error_class       text;
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS occurrence_count  integer NOT NULL DEFAULT 1;
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS first_occurrence  timestamptz;
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS last_occurrence   timestamptz;
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS opened_at         timestamptz;
ALTER TABLE public.ai_alerts ADD COLUMN IF NOT EXISTS last_notified_at  timestamptz;

-- 3. Pure classifier used by both RPCs so the window-count logic can never
--    drift between "open" and "recover". Mirrors classifyProviderError() in
--    api/_ai-gateway/alerts.ts. Connectivity (timeout / network) has no HTTP
--    status, so it is represented as http_status IS NULL — the same shape the
--    gateway persists for an AbortError / connection error.
CREATE OR REPLACE FUNCTION public._ai_alert_status_matches_class(
  p_http_status integer,
  p_error_class text
) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_error_class
    WHEN 'auth'         THEN p_http_status IN (401, 403)
    WHEN 'rate_limit'   THEN p_http_status = 429
    WHEN 'server'       THEN p_http_status BETWEEN 500 AND 599
    WHEN 'connectivity' THEN p_http_status IS NULL
    ELSE false
  END;
$$;

-- 4. Atomic incident recorder. Called fire-and-forget once per provider
--    failure. Returns a JSON verdict; the caller sends the OPEN email ONLY when
--    should_send_email = true (won the insert AND cooldown clear).
--
--    Concurrency: the open path is an INSERT … ON CONFLICT on the existing
--    partial unique index idx_alerts_dedup_active (dedup_key, environment)
--    WHERE status <> 'resolved'. With N instances racing on the same failure,
--    exactly one INSERTs (xmax = 0) and every other collapses to a harmless
--    counter increment → exactly one OPEN email.
CREATE OR REPLACE FUNCTION public.record_provider_incident(
  p_environment    text,
  p_provider_raw   text,   -- ai_usage_events.provider, e.g. 'azure' | 'openai'
  p_provider_label text,   -- display / dedup label, e.g. 'azure_speech'
  p_error_class    text,   -- 'auth' | 'rate_limit' | 'server' | 'connectivity'
  p_dedup_key      text,   -- '{environment}:{provider_label}:{error_class}'
  p_title          text,
  p_detail         jsonb,
  p_now            timestamptz DEFAULT now()
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_rule            record;
  v_window_seconds  integer;
  v_min_events      integer;
  v_cooldown_secs   integer;
  v_severity        text;
  v_rule_id         uuid;
  v_active          record;
  v_count           integer;
  v_last_notified   timestamptz;
  v_cooldown_ok     boolean;
  v_alert_id        uuid;
  v_was_inserted    boolean;
BEGIN
  -- ── Resolve the configurable rule, or fall back to safe built-in defaults
  --    so a missing seed never silences a critical auth alert. ──────────────
  SELECT * INTO v_rule
    FROM public.ai_alert_rules
   WHERE environment = p_environment
     AND alert_type  = 'error_rate'
     AND scope       = p_error_class
     AND active
   ORDER BY updated_at DESC
   LIMIT 1;

  IF FOUND THEN
    v_window_seconds := v_rule.window_seconds;
    v_min_events     := v_rule.min_event_count;
    v_cooldown_secs  := v_rule.cooldown_seconds;
    v_severity       := v_rule.severity;
    v_rule_id        := v_rule.id;
  ELSE
    v_rule_id := NULL;
    CASE p_error_class
      WHEN 'auth'         THEN v_window_seconds := 300;  v_min_events := 1;  v_cooldown_secs := 21600; v_severity := 'critical';
      WHEN 'rate_limit'   THEN v_window_seconds := 600;  v_min_events := 20; v_cooldown_secs := 3600;  v_severity := 'info';
      WHEN 'server'       THEN v_window_seconds := 300;  v_min_events := 5;  v_cooldown_secs := 1800;  v_severity := 'warning';
      WHEN 'connectivity' THEN v_window_seconds := 300;  v_min_events := 5;  v_cooldown_secs := 1800;  v_severity := 'warning';
      ELSE RETURN jsonb_build_object('action', 'unknown_class', 'should_send_email', false);
    END CASE;
  END IF;

  -- ── Already-open incident → just increment; never recount, never re-email.
  --    This is the hot path when a provider is down and thousands of requests
  --    fail: 5000 failures → 1 row, 5000 cheap increments, 0 extra emails. ──
  SELECT id INTO v_active
    FROM public.ai_alerts
   WHERE dedup_key = p_dedup_key
     AND environment = p_environment
     AND status <> 'resolved'
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.ai_alerts
       SET occurrence_count = occurrence_count + 1,
           last_occurrence  = p_now,
           detail           = COALESCE(p_detail, detail),
           updated_at       = now()
     WHERE id = v_active.id;
    RETURN jsonb_build_object(
      'action', 'incremented',
      'alert_id', v_active.id,
      'should_send_email', false,
      'severity', v_severity
    );
  END IF;

  -- ── No open incident: count same-class failures in the window (the current
  --    failing event was already persisted by failEvent, so it is included). ─
  SELECT count(*) INTO v_count
    FROM public.ai_usage_events e
   WHERE e.provider = p_provider_raw
     AND e.status = 'failed'
     AND e.started_at >= p_now - make_interval(secs => v_window_seconds)
     AND public._ai_alert_status_matches_class(e.http_status, p_error_class);

  IF v_count < v_min_events THEN
    RETURN jsonb_build_object(
      'action', 'below_threshold',
      'should_send_email', false,
      'occurrence_count', v_count,
      'threshold', v_min_events,
      'severity', v_severity
    );
  END IF;

  -- ── Cooldown vs the most recent notification for this dedup_key (across the
  --    resolve/reopen boundary) — suppresses e-mail flapping. ────────────────
  SELECT max(last_notified_at) INTO v_last_notified
    FROM public.ai_alerts
   WHERE dedup_key = p_dedup_key
     AND environment = p_environment;

  v_cooldown_ok := v_last_notified IS NULL
                OR p_now - v_last_notified >= make_interval(secs => v_cooldown_secs);

  -- ── Atomic open. Only the true INSERT (xmax = 0) is allowed to e-mail. ────
  INSERT INTO public.ai_alerts (
    environment, rule_id, alert_type, scope, provider, error_class, severity,
    status, title, detail, dedup_key,
    occurrence_count, first_occurrence, last_occurrence, opened_at, last_notified_at
  ) VALUES (
    p_environment, v_rule_id, 'error_rate', p_error_class, p_provider_raw, p_error_class, v_severity,
    'open', p_title, COALESCE(p_detail, '{}'::jsonb), p_dedup_key,
    v_count, p_now, p_now, p_now,
    CASE WHEN v_cooldown_ok THEN p_now ELSE NULL END
  )
  ON CONFLICT (dedup_key, environment) WHERE status <> 'resolved'
  DO UPDATE SET
    occurrence_count = ai_alerts.occurrence_count + 1,
    last_occurrence  = p_now,
    detail           = COALESCE(EXCLUDED.detail, ai_alerts.detail),
    updated_at       = now()
  RETURNING id, (xmax = 0) INTO v_alert_id, v_was_inserted;

  RETURN jsonb_build_object(
    'action', CASE WHEN v_was_inserted AND v_cooldown_ok THEN 'opened'
                   WHEN v_was_inserted THEN 'opened_cooldown_suppressed'
                   ELSE 'raced_increment' END,
    'alert_id', v_alert_id,
    'should_send_email', (v_was_inserted AND v_cooldown_ok),
    'occurrence_count', v_count,
    'severity', v_severity
  );
END;
$$;

-- 5. Atomic recovery / orphan closer, called once per open incident by the
--    recovery sweep. The status='open' guard on the UPDATE means only ONE
--    concurrent sweep tick flips it → exactly one RECOVERED email. Returns the
--    incident payload when it recovered so the caller can build that email.
CREATE OR REPLACE FUNCTION public.resolve_provider_incident_if_recovered(
  p_alert_id                uuid,
  p_recovery_window_seconds integer DEFAULT 600,
  p_orphan_max_open_seconds integer DEFAULT 86400,
  p_now                     timestamptz DEFAULT now()
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_alert           public.ai_alerts;
  v_recent_failures integer;
  v_recent_success  boolean;
BEGIN
  SELECT * INTO v_alert
    FROM public.ai_alerts
   WHERE id = p_alert_id AND status = 'open'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'not_open');
  END IF;

  -- Still failing in the recovery window → keep the incident open, no email.
  SELECT count(*) INTO v_recent_failures
    FROM public.ai_usage_events e
   WHERE e.provider = v_alert.provider
     AND e.status = 'failed'
     AND e.started_at >= p_now - make_interval(secs => p_recovery_window_seconds)
     AND public._ai_alert_status_matches_class(e.http_status, v_alert.error_class);

  IF v_recent_failures > 0 THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'still_failing');
  END IF;

  -- A recent SUCCESS for this provider proves it is genuinely back.
  SELECT EXISTS (
    SELECT 1 FROM public.ai_usage_events e
     WHERE e.provider = v_alert.provider
       AND e.status = 'succeeded'
       AND e.started_at >= p_now - make_interval(secs => p_recovery_window_seconds)
  ) INTO v_recent_success;

  IF v_recent_success THEN
    UPDATE public.ai_alerts
       SET status = 'resolved', resolved_at = p_now,
           resolve_reason = 'auto_recovered', updated_at = now()
     WHERE id = p_alert_id AND status = 'open';

    RETURN jsonb_build_object(
      'resolved', true, 'recovered', true,
      'alert_id', v_alert.id, 'environment', v_alert.environment,
      'provider', v_alert.provider, 'error_class', v_alert.error_class,
      'severity', v_alert.severity, 'dedup_key', v_alert.dedup_key,
      'occurrence_count', v_alert.occurrence_count,
      'opened_at', v_alert.opened_at,
      'first_occurrence', v_alert.first_occurrence,
      'last_occurrence', v_alert.last_occurrence,
      'detail', v_alert.detail
    );
  END IF;

  -- Neither failing nor succeeding for a long time → orphan; close it quietly
  -- (no RECOVERED email: we cannot claim recovery we never observed).
  IF v_alert.opened_at IS NOT NULL
     AND p_now - v_alert.opened_at >= make_interval(secs => p_orphan_max_open_seconds) THEN
    UPDATE public.ai_alerts
       SET status = 'resolved', resolved_at = p_now,
           resolve_reason = 'auto_closed_stale', updated_at = now()
     WHERE id = p_alert_id AND status = 'open';
    RETURN jsonb_build_object('resolved', true, 'recovered', false, 'reason', 'orphan_closed', 'alert_id', v_alert.id);
  END IF;

  RETURN jsonb_build_object('resolved', false, 'reason', 'no_recent_success');
END;
$$;

-- 6. pg_net cron entry point for the recovery / backstop sweep. Mirrors
--    public.conversation_cron_sweep_stale_sessions exactly (Vault secrets
--    cron_secret + app_base_url, Authorization: Bearer). NOT auto-scheduled
--    here — same deliberate convention as the baseline. Reference command:
--
--      SELECT cron.schedule(
--        'operational-alerts-recovery-sweep',
--        '*/5 * * * *',
--        $$SELECT public.alerts_cron_recovery_sweep()$$
--      );
CREATE OR REPLACE FUNCTION public.alerts_cron_recovery_sweep()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_secret text;
  v_url    text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'  LIMIT 1;
    SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'app_base_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'alerts_cron_recovery_sweep: vault read failed: %', SQLERRM;
    RETURN;
  END;

  IF v_secret IS NULL OR v_url IS NULL THEN
    RAISE WARNING 'alerts_cron_recovery_sweep: vault secrets missing (cron_secret or app_base_url)';
    RETURN;
  END IF;

  PERFORM net.http_get(
    url     := v_url || '/api/internal/listening/alerts-recovery-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret)
  );
END;
$$;

-- 7. Seed the configurable rules for production and homologation (staging).
--    Idempotent via NOT EXISTS (no new unique constraint added to a historical
--    table). created_by NULL = system-owned.
INSERT INTO public.ai_alert_rules
  (environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
SELECT v.environment, v.alert_type, v.scope, v.window_seconds, v.threshold_value, v.min_event_count, v.severity, v.active, v.cooldown_seconds, v.created_by
FROM (VALUES
  -- environment, alert_type,  scope,          window, threshold, min_events, severity,   active, cooldown, created_by
  ('production', 'error_rate', 'auth',            300, NULL::numeric, 1,  'critical', true, 21600, NULL::uuid),
  ('production', 'error_rate', 'rate_limit',      600, NULL::numeric, 20, 'info',     true,  3600, NULL::uuid),
  ('production', 'error_rate', 'server',          300, NULL::numeric, 5,  'warning',  true,  1800, NULL::uuid),
  ('production', 'error_rate', 'connectivity',    300, NULL::numeric, 5,  'warning',  true,  1800, NULL::uuid),
  ('staging',    'error_rate', 'auth',            300, NULL::numeric, 1,  'critical', true, 21600, NULL::uuid),
  ('staging',    'error_rate', 'rate_limit',      600, NULL::numeric, 20, 'info',     true,  3600, NULL::uuid),
  ('staging',    'error_rate', 'server',          300, NULL::numeric, 5,  'warning',  true,  1800, NULL::uuid),
  ('staging',    'error_rate', 'connectivity',    300, NULL::numeric, 5,  'warning',  true,  1800, NULL::uuid)
) AS v(environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_alert_rules r
   WHERE r.environment = v.environment
     AND r.alert_type  = v.alert_type
     AND r.scope       = v.scope
);

-- 8. Grants — backend-only (service_role) surface; nothing here is exposed to
--    anon / authenticated. The functions are SECURITY DEFINER, so they run with
--    owner privilege regardless, but execution is still locked down.
REVOKE ALL ON FUNCTION public._ai_alert_status_matches_class(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_provider_incident(text, text, text, text, text, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_provider_incident_if_recovered(uuid, integer, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.alerts_cron_recovery_sweep() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public._ai_alert_status_matches_class(integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_provider_incident(text, text, text, text, text, text, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_provider_incident_if_recovered(uuid, integer, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.alerts_cron_recovery_sweep() TO service_role;
