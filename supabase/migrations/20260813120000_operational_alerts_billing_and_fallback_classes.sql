-- =============================================================================
-- Operational alerts — close the "silent provider outage" gaps.
-- -----------------------------------------------------------------------------
-- Additive, idempotent, backward-compatible. Does NOT edit the already-applied
-- 20260812230000 / 20260812240000 migrations. Extends the existing operational-
-- alerts machinery with two new error classes so no genuine Azure/OpenAI outage
-- can stay silent:
--
--   * 'billing'        — a billing / credit / quota / subscription block that
--                        stops the provider from serving us, even when the HTTP
--                        status is NOT 401/403 (OpenAI insufficient_quota is
--                        HTTP 429; Payment Required is 402). Critical & immediate
--                        (min_event_count = 1), same urgency as 'auth'.
--   * 'provider_error' — a MONITORED fallback for any genuine provider error that
--                        does not match a specific class (402-handled, 404, 408,
--                        409, other 4xx, or an error with no HTTP status and no
--                        connectivity signature). Never silent, but guarded by a
--                        conservative threshold (3 in 5 min, severity 'warning')
--                        so a one-off oddity does not e-mail.
--
-- The classification here MIRRORS classifyProviderError() /
-- isBillingBlockSignal() in api/_ai-gateway/alerts.ts. The window-count and the
-- recovery detector are made CODE-AWARE (they already read ai_usage_events, which
-- stores error_code / error_category on failed events) so a billing block is
-- counted as 'billing' — not confused with a transient 429 rate limit — and a
-- provider_error is counted precisely.
-- =============================================================================

-- 1. Structured-code predicates (mirror the TS sets/regex in alerts.ts). IMMUTABLE
--    so they can be inlined in the count queries. Billing keys ONLY on the
--    structured error code — never a fragile message substring.
CREATE OR REPLACE FUNCTION public._ai_error_code_is_billing(p_code text)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT lower(coalesce(p_code, '')) IN (
    'insufficient_quota',
    'billing_hard_limit_reached',
    'billing_not_active',
    'account_deactivated',
    'access_terminated',
    'quota_exceeded',
    'quotaexceeded'
  );
$$;

CREATE OR REPLACE FUNCTION public._ai_error_code_is_connectivity(p_code text, p_category text)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  -- Mirrors CONNECTIVITY_HINT in api/_ai-gateway/alerts.ts (matched against the
  -- sanitized error code + category the gateway persisted on the failed event).
  SELECT (coalesce(p_code, '') || ' ' || coalesce(p_category, '')) ~*
    ('timeout|timed out|abort|econnreset|econnrefused|enotfound|network|connection'
     || '|fetch failed|socket|apiconnection|azure_speech_timeout|azure_speech_unavailable'
     || '|azure_tts_timeout|azure_tts_network|azure_network');
$$;

-- 2. Single source of truth for "which class does THIS failed event belong to",
--    mirroring the exact priority order of classifyProviderError() (billing wins
--    over auth/rate_limit; connectivity only when there is no HTTP status and the
--    signature matches; everything else genuine-but-unclassified → provider_error).
CREATE OR REPLACE FUNCTION public._ai_alert_event_class(
  p_http_status   integer,
  p_error_code    text,
  p_error_category text
) RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_http_status = 402 OR public._ai_error_code_is_billing(p_error_code) THEN 'billing'
    WHEN p_http_status IN (401, 403)                                           THEN 'auth'
    WHEN p_http_status = 429                                                   THEN 'rate_limit'
    WHEN p_http_status BETWEEN 500 AND 599                                     THEN 'server'
    WHEN p_http_status IS NULL
         AND public._ai_error_code_is_connectivity(p_error_code, p_error_category) THEN 'connectivity'
    ELSE 'provider_error'
  END;
$$;

-- 3. Code-aware overload of the class matcher (4 args). The original 2-arg
--    _ai_alert_status_matches_class(integer, text) is left in place untouched for
--    backward compatibility; the RPCs below now use this precise version.
CREATE OR REPLACE FUNCTION public._ai_alert_status_matches_class(
  p_http_status    integer,
  p_error_class    text,
  p_error_code     text,
  p_error_category text
) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT public._ai_alert_event_class(p_http_status, p_error_code, p_error_category) = p_error_class;
$$;

-- 4. Recreate record_provider_incident (SAME signature) with:
--      * 'billing' + 'provider_error' branches in the built-in default rules
--        (so a missing seed can never silence them);
--      * a CODE-AWARE window count.
CREATE OR REPLACE FUNCTION public.record_provider_incident(
  p_environment    text,
  p_provider_raw   text,
  p_provider_label text,
  p_error_class    text,
  p_dedup_key      text,
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
      WHEN 'auth'           THEN v_window_seconds := 300;  v_min_events := 1;  v_cooldown_secs := 21600; v_severity := 'critical';
      WHEN 'billing'        THEN v_window_seconds := 300;  v_min_events := 1;  v_cooldown_secs := 21600; v_severity := 'critical';
      WHEN 'rate_limit'     THEN v_window_seconds := 600;  v_min_events := 20; v_cooldown_secs := 3600;  v_severity := 'info';
      WHEN 'server'         THEN v_window_seconds := 300;  v_min_events := 5;  v_cooldown_secs := 1800;  v_severity := 'warning';
      WHEN 'connectivity'   THEN v_window_seconds := 300;  v_min_events := 5;  v_cooldown_secs := 1800;  v_severity := 'warning';
      WHEN 'provider_error' THEN v_window_seconds := 300;  v_min_events := 3;  v_cooldown_secs := 1800;  v_severity := 'warning';
      ELSE RETURN jsonb_build_object('action', 'unknown_class', 'should_send_email', false);
    END CASE;
  END IF;

  -- Already-open incident → just increment; never recount, never re-email.
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

  -- No open incident: count same-class failures in the window (CODE-AWARE, so a
  -- billing 429 is counted as 'billing' and not as a transient rate limit).
  SELECT count(*) INTO v_count
    FROM public.ai_usage_events e
   WHERE e.provider = p_provider_raw
     AND e.status = 'failed'
     AND e.started_at >= p_now - make_interval(secs => v_window_seconds)
     AND public._ai_alert_status_matches_class(e.http_status, p_error_class, e.error_code, e.error_category);

  IF v_count < v_min_events THEN
    RETURN jsonb_build_object(
      'action', 'below_threshold',
      'should_send_email', false,
      'occurrence_count', v_count,
      'threshold', v_min_events,
      'severity', v_severity
    );
  END IF;

  SELECT max(last_notified_at) INTO v_last_notified
    FROM public.ai_alerts
   WHERE dedup_key = p_dedup_key
     AND environment = p_environment;

  v_cooldown_ok := v_last_notified IS NULL
                OR p_now - v_last_notified >= make_interval(secs => v_cooldown_secs);

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

-- 5. Recreate resolve_provider_incident_if_recovered (SAME signature) with a
--    CODE-AWARE "still failing" count so recovery of a billing / provider_error
--    incident is judged against the same class definition used to open it.
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

  SELECT count(*) INTO v_recent_failures
    FROM public.ai_usage_events e
   WHERE e.provider = v_alert.provider
     AND e.status = 'failed'
     AND e.started_at >= p_now - make_interval(secs => p_recovery_window_seconds)
     AND public._ai_alert_status_matches_class(e.http_status, v_alert.error_class, e.error_code, e.error_category);

  IF v_recent_failures > 0 THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'still_failing');
  END IF;

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

-- 6. Seed the configurable rules for the two new classes (production + staging),
--    idempotent via NOT EXISTS on (environment, alert_type, scope).
--      billing        → critical, immediate (min 1), 6h cooldown  (same as auth)
--      provider_error → warning, conservative (min 3 / 5 min), 30m cooldown
INSERT INTO public.ai_alert_rules
  (environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
SELECT v.environment, v.alert_type, v.scope, v.window_seconds, v.threshold_value, v.min_event_count, v.severity, v.active, v.cooldown_seconds, v.created_by
FROM (VALUES
  ('production', 'error_rate', 'billing',        300, NULL::numeric, 1, 'critical', true, 21600, NULL::uuid),
  ('production', 'error_rate', 'provider_error', 300, NULL::numeric, 3, 'warning',  true,  1800, NULL::uuid),
  ('staging',    'error_rate', 'billing',        300, NULL::numeric, 1, 'critical', true, 21600, NULL::uuid),
  ('staging',    'error_rate', 'provider_error', 300, NULL::numeric, 3, 'warning',  true,  1800, NULL::uuid)
) AS v(environment, alert_type, scope, window_seconds, threshold_value, min_event_count, severity, active, cooldown_seconds, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ai_alert_rules r
   WHERE r.environment = v.environment
     AND r.alert_type  = v.alert_type
     AND r.scope       = v.scope
);

-- 7. Grants — backend-only surface. The production DB's ALTER DEFAULT PRIVILEGES
--    auto-grants EXECUTE on new public functions to anon + authenticated (see the
--    20260812240000 lockdown migration), so every new function here must revoke
--    those explicitly and be granted only to service_role.
REVOKE ALL ON FUNCTION public._ai_error_code_is_billing(text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ai_error_code_is_connectivity(text, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ai_alert_event_class(integer, text, text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ai_alert_status_matches_class(integer, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._ai_error_code_is_billing(text)                          TO service_role;
GRANT EXECUTE ON FUNCTION public._ai_error_code_is_connectivity(text, text)               TO service_role;
GRANT EXECUTE ON FUNCTION public._ai_alert_event_class(integer, text, text)               TO service_role;
GRANT EXECUTE ON FUNCTION public._ai_alert_status_matches_class(integer, text, text, text) TO service_role;

-- record_provider_incident / resolve_provider_incident_if_recovered keep their
-- original signatures and grants (service_role-only from 20260812230000/240000);
-- CREATE OR REPLACE does not alter existing grants.
