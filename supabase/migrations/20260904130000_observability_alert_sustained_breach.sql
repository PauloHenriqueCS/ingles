-- =============================================================================
-- Observability alerts: sustained-breach floor + higher latency sample floor
-- -----------------------------------------------------------------------------
-- A single 5-minute burst was enough to page: run_observability_alert_sweep
-- (20260831130000) e-mails on the FIRST sweep whose p95 crosses threshold, and
-- the latency rules trusted a percentile over as few as 15 samples in a 1h
-- window. The 2026-09-04 production alert (DB p95 1686ms) was exactly this — a
-- transient ~10-minute spike, self-recovered, but it still fired.
--
-- Two data-driven guards, both tunable in ai_alert_rules with NO deploy:
--   1. min_breach_occurrences — how many breaching sweeps an incident must
--      accumulate before the OPEN e-mail is sent. Default 1 preserves today's
--      "fire immediately" behavior for every existing rule (notably http_5xx,
--      which must still alert on the first sweep). Latency rules move to 2 (~10
--      min of sustained breach at the */5 cron cadence).
--   2. a higher min_event_count for the latency rules (15 → 30) so a p95 is only
--      trusted over a more meaningful sample.
--
-- The incident is still OPENED (and its occurrence_count accumulates) from the
-- first breaching sweep — only the NOTIFICATION is held back until the floor is
-- crossed. Recovery / escalation / cooldown / dedup are all unchanged.
-- =============================================================================

-- 1. New tunable. NOT NULL DEFAULT 1 ⇒ every existing rule keeps firing on the
--    first sweep until explicitly raised below.
ALTER TABLE public.ai_alert_rules
  ADD COLUMN IF NOT EXISTS min_breach_occurrences integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.ai_alert_rules.min_breach_occurrences IS
  'Number of breaching sweeps an incident must accumulate before the OPEN e-mail '
  'is sent (sustained-breach floor). 1 = notify on the first sweep. Only the '
  'notification is delayed; the incident is still opened from the first breach.';

-- 2. Rewrite the sweep to honour min_breach_occurrences. Only the BREACH branch
--    changes; the metric helper, recovery, orphan-close, cooldown and dedup are
--    byte-for-byte the same as 20260831130000.
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
  v_rule           record;
  v_sample         integer;
  v_value          numeric;
  v_threshold      numeric;
  v_is_latency     boolean;
  v_breach         boolean;
  v_recovered_ok   boolean;
  v_severity       text;
  v_dedup_key      text;
  v_title          text;
  v_detail         jsonb;
  v_metric_name    text;
  v_active         record;
  v_last_notified  timestamptz;
  v_cooldown_ok    boolean;
  v_alert_id       uuid;
  v_was_inserted   boolean;
  v_notify_now     boolean;
  v_opened         jsonb := '[]'::jsonb;
  v_recovered      jsonb := '[]'::jsonb;
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
      v_breach := v_sample >= v_rule.min_event_count
                  AND v_value IS NOT NULL
                  AND v_threshold IS NOT NULL
                  AND v_value >= v_threshold;
      v_recovered_ok := v_sample >= v_rule.min_event_count
                        AND v_value IS NOT NULL
                        AND v_threshold IS NOT NULL
                        AND v_value < v_threshold;
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
      v_metric_name := 'http_5xx_count';
      v_breach := v_value >= v_rule.min_event_count;
      v_recovered_ok := (v_value = 0);
      v_severity := v_rule.severity;
      v_title := 'HTTP 5xx spike — ' || COALESCE(v_value::text, '0') || ' in '
                 || v_rule.window_seconds || 's';
    END IF;

    v_detail := jsonb_build_object(
      'metric',          v_metric_name,
      'scope',           v_rule.scope,
      'value',           v_value,
      'threshold',       v_threshold,
      'sample_count',    v_sample,
      'window_seconds',  v_rule.window_seconds,
      'min_event_count', v_rule.min_event_count,
      'min_breach_occurrences', v_rule.min_breach_occurrences
    );

    -- ── BREACH ────────────────────────────────────────────────────────────────
    IF v_breach THEN
      -- Cooldown baseline: the most recent notification for this dedup key
      -- (any status), so a resolved-then-reopened incident still respects it.
      SELECT max(last_notified_at) INTO v_last_notified
        FROM public.ai_alerts
       WHERE dedup_key = v_dedup_key AND environment = p_environment;
      v_cooldown_ok := v_last_notified IS NULL
                    OR p_now - v_last_notified >= make_interval(secs => v_rule.cooldown_seconds);

      SELECT id, occurrence_count, last_notified_at, opened_at
        INTO v_active
        FROM public.ai_alerts
       WHERE dedup_key = v_dedup_key AND environment = p_environment AND status <> 'resolved'
       FOR UPDATE
       LIMIT 1;

      IF FOUND THEN
        -- Already open → accumulate. Notify the first time it crosses the
        -- sustained-breach floor AND cooldown allows; stamp last_notified_at so
        -- the OPEN e-mail is emitted exactly once.
        v_notify_now := v_active.last_notified_at IS NULL
                        AND (v_active.occurrence_count + 1) >= v_rule.min_breach_occurrences
                        AND v_cooldown_ok;

        UPDATE public.ai_alerts
           SET occurrence_count = occurrence_count + 1,
               last_occurrence  = p_now,
               detail           = v_detail,
               severity         = CASE WHEN v_severity = 'critical' THEN 'critical' ELSE severity END,
               title            = v_title,
               last_notified_at = CASE WHEN v_notify_now THEN p_now ELSE last_notified_at END,
               updated_at       = now()
         WHERE id = v_active.id;

        IF v_notify_now THEN
          v_opened := v_opened || jsonb_build_object(
            'alert_id',   v_active.id,
            'dedup_key',  v_dedup_key,
            'alert_type', v_rule.alert_type,
            'scope',      v_rule.scope,
            'severity',   v_severity,
            'title',      v_title,
            'detail',     v_detail,
            'opened_at',  v_active.opened_at
          );
        END IF;
        CONTINUE;
      END IF;

      -- No open incident → open one. Notify immediately only when the floor is
      -- <= 1 (unchanged behavior for http_5xx and any rule left at the default).
      v_notify_now := v_cooldown_ok AND v_rule.min_breach_occurrences <= 1;

      INSERT INTO public.ai_alerts (
        environment, rule_id, alert_type, scope, provider, error_class, severity,
        status, title, detail, dedup_key,
        occurrence_count, first_occurrence, last_occurrence, opened_at, last_notified_at
      ) VALUES (
        p_environment, v_rule.id, v_rule.alert_type, v_rule.scope, NULL, NULL, v_severity,
        'open', v_title, v_detail, v_dedup_key,
        1, p_now, p_now, p_now,
        CASE WHEN v_notify_now THEN p_now ELSE NULL END
      )
      ON CONFLICT (dedup_key, environment) WHERE status <> 'resolved'
      DO UPDATE SET
        occurrence_count = ai_alerts.occurrence_count + 1,
        last_occurrence  = p_now,
        detail           = EXCLUDED.detail,
        updated_at       = now()
      RETURNING id, (xmax = 0) INTO v_alert_id, v_was_inserted;

      IF v_was_inserted AND v_notify_now THEN
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

          -- Only announce a recovery for an incident the user was actually told
          -- about — a held-back (never-notified) transient blip resolves silently.
          IF v_active.last_notified_at IS NOT NULL THEN
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
          END IF;
        ELSIF v_active.opened_at IS NOT NULL
              AND p_now - v_active.opened_at >= make_interval(secs => p_orphan_max_open_seconds) THEN
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

REVOKE ALL ON FUNCTION public.run_observability_alert_sweep(text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_observability_alert_sweep(text, timestamptz, integer) TO service_role;

-- 3. Tune the latency rules: require ~10 min of sustained breach (2 sweeps) and
--    a larger sample before trusting the p95. http_5xx stays at floor 1 (alert
--    fast on real 5xx). Data-only — safe to re-tune later with no deploy.
UPDATE public.ai_alert_rules
   SET min_breach_occurrences = 2,
       min_event_count = GREATEST(min_event_count, 30)
 WHERE alert_type = 'latency_p95'
   AND scope IN ('db_latency', 'api_latency')
   AND environment IN ('production', 'staging');

UPDATE public.ai_alert_rules
   SET min_breach_occurrences = 2
 WHERE alert_type = 'latency_p95'
   AND scope = 'client_latency'
   AND environment IN ('production', 'staging');
