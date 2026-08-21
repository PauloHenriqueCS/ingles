-- ============================================================================
-- Cost-divergence acknowledgements: let an admin ACCEPT a divergent valuation.
-- ----------------------------------------------------------------------------
-- Context: ai_cost_valuations.divergence_status='divergent' means the engine's
-- recomputed cost disagrees with the cost the Gateway ORIGINALLY reported on
-- the immutable ai_usage_events row. Because the original reported cost never
-- changes, reprocessing re-flags the same events as divergent forever — e.g.
-- the 8 `gpt-realtime-2.1-mini` realtime events whose cost the v2 engine
-- (pricing-cost-engine-v2) correctly raised. That is an alert nobody can ever
-- clear, which is exactly the noise we want to remove.
--
-- Resolution: an admin reviews a divergence and ACCEPTS the recomputed value as
-- authoritative. We fingerprint the acceptance by the valuation's input_hash
-- (event metrics + pricing version + engine), so the acknowledgement carries
-- across future reprocessing that yields the SAME inputs, but a genuinely NEW
-- divergence (different inputs → different hash) still surfaces for review.
--
-- Writes only ever happen through the SECURITY DEFINER RPCs below; direct table
-- writes are denied by RLS, mirroring ai_cost_valuations.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_cost_divergence_acks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES public.ai_usage_events(id) ON DELETE CASCADE,
  -- Fingerprint of the accepted divergence. Same inputs → same hash → the ack
  -- survives reprocessing; new inputs → new hash → re-alerts for review.
  input_hash    text NOT NULL,
  valuation_id  uuid REFERENCES public.ai_cost_valuations(id) ON DELETE SET NULL,
  acked_by      uuid,
  acked_at      timestamptz NOT NULL DEFAULT now(),
  reason        text,
  UNIQUE (event_id, input_hash)
);

CREATE INDEX IF NOT EXISTS ai_cost_divergence_acks_event_idx
  ON public.ai_cost_divergence_acks (event_id);

ALTER TABLE public.ai_cost_divergence_acks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cost_divergence_acks_read  ON public.ai_cost_divergence_acks;
DROP POLICY IF EXISTS cost_divergence_acks_write ON public.ai_cost_divergence_acks;
CREATE POLICY cost_divergence_acks_read  ON public.ai_cost_divergence_acks
  AS PERMISSIVE FOR SELECT TO public USING (is_active_admin());
CREATE POLICY cost_divergence_acks_write ON public.ai_cost_divergence_acks
  AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_cost_divergence_acks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_cost_divergence_acks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_cost_divergence_acks TO postgres;

-- ----------------------------------------------------------------------------
-- Acknowledge ONE event's current divergence.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_acknowledge_cost_divergence_v1(
  p_event_id uuid,
  p_reason   text,
  p_actor_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_latest record;
BEGIN
  SELECT v.id, v.input_hash, v.divergence_status
    INTO v_latest
  FROM ai_cost_valuations v
  WHERE v.event_id = p_event_id
  ORDER BY v.created_at DESC
  LIMIT 1;

  IF v_latest.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_valuation');
  END IF;
  IF v_latest.divergence_status IS DISTINCT FROM 'divergent' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_divergent');
  END IF;
  IF v_latest.input_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_input_hash');
  END IF;

  INSERT INTO ai_cost_divergence_acks (event_id, input_hash, valuation_id, acked_by, reason)
  VALUES (p_event_id, v_latest.input_hash, v_latest.id, p_actor_id, p_reason)
  ON CONFLICT (event_id, input_hash)
  DO UPDATE SET valuation_id = EXCLUDED.valuation_id,
                acked_by     = EXCLUDED.acked_by,
                acked_at     = now(),
                reason       = EXCLUDED.reason;

  RETURN jsonb_build_object('ok', true, 'input_hash', v_latest.input_hash);
END;
$function$;

-- ----------------------------------------------------------------------------
-- Acknowledge ALL currently-unacknowledged divergences from the last 30 days.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_acknowledge_all_cost_divergences_v1(
  p_reason   text,
  p_actor_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH divergent AS (
    SELECT e.id AS event_id, latest.id AS valuation_id, latest.input_hash
    FROM ai_usage_events e
    JOIN LATERAL (
      SELECT v.id, v.input_hash, v.divergence_status
      FROM ai_cost_valuations v
      WHERE v.event_id = e.id
      ORDER BY v.created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE e.started_at > now() - interval '30 days'
      AND latest.divergence_status = 'divergent'
      AND latest.input_hash IS NOT NULL
  ), inserted AS (
    INSERT INTO ai_cost_divergence_acks (event_id, input_hash, valuation_id, acked_by, reason)
    SELECT d.event_id, d.input_hash, d.valuation_id, p_actor_id, p_reason
    FROM divergent d
    ON CONFLICT (event_id, input_hash)
    DO UPDATE SET valuation_id = EXCLUDED.valuation_id,
                  acked_by     = EXCLUDED.acked_by,
                  acked_at     = now(),
                  reason       = EXCLUDED.reason
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM inserted;

  RETURN jsonb_build_object('ok', true, 'acknowledged', v_count);
END;
$function$;

-- ----------------------------------------------------------------------------
-- List the currently-unacknowledged divergences (last 30 days) for review.
-- p_environment is accepted for signature symmetry; ai_usage_events are not
-- environment-scoped, matching admin_get_pricing_quality_v1.divergent_events_30d.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_cost_divergences_v1(
  p_environment text,
  p_limit       integer DEFAULT 100
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t))
    FROM (
      SELECT e.id AS event_id, e.provider, e.model, e.feature_key, e.started_at,
             latest.original_cost_total, latest.cost_total, latest.currency,
             latest.divergence_abs, latest.divergence_pct
      FROM ai_usage_events e
      JOIN LATERAL (
        SELECT v.id, v.input_hash, v.divergence_status,
               v.original_cost_total, v.cost_total, v.currency,
               v.divergence_abs, v.divergence_pct
        FROM ai_cost_valuations v
        WHERE v.event_id = e.id
        ORDER BY v.created_at DESC
        LIMIT 1
      ) latest ON true
      WHERE e.started_at > now() - interval '30 days'
        AND latest.divergence_status = 'divergent'
        AND NOT EXISTS (
          SELECT 1 FROM ai_cost_divergence_acks a
          WHERE a.event_id = e.id AND a.input_hash = latest.input_hash
        )
      ORDER BY latest.divergence_pct DESC NULLS LAST
      LIMIT LEAST(GREATEST(p_limit, 1), 500)
    ) t
  ), '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_acknowledge_cost_divergence_v1(uuid, text, uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_acknowledge_cost_divergence_v1(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_acknowledge_all_cost_divergences_v1(text, uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_acknowledge_all_cost_divergences_v1(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_cost_divergences_v1(text, integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.admin_list_cost_divergences_v1(text, integer) TO service_role;
