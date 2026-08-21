-- ============================================================================
-- Pricing quality, take 2: "sem preço" must mean a REAL, un-priceable cost.
-- ----------------------------------------------------------------------------
-- The previous take (20260821170000) restricted unpriced/models_without_rate to
-- billable events, dropping ~167 non-billable control events, leaving 23. But
-- those 23 keyed off ai_cost_valuations — the admin REPROCESSING/audit table,
-- populated only when someone runs "reprocessar custos". Live events therefore
-- look "sem preço" until reprocessed, and 22 of the 23 were in fact FAILED calls
-- (Azure TTS 401, translate/two_part_tts errors) that have no cost at all. The
-- Gateway already prices every real call at write time and stamps the AUTHORITATIVE
-- outcome on ai_usage_events.cost_status (all 607 billable succeeded events =
-- 'calculated'; failures = 'not_applicable'). ai_cost_valuations lagging behind
-- is reprocessing backlog, not a catalog hole.
--
-- New definition of "sem preço": a billable, SUCCEEDED event whose OWN
-- cost_status is not 'calculated' — i.e. the Gateway itself could not price a
-- real billable call. That is the only actionable catalog gap; it reads 0 today
-- and only rises when a rate is genuinely missing. models_without_rate uses the
-- same authoritative signal.
--
-- Divergent count now excludes acknowledged divergences (see the companion
-- migration 20260821180000_cost_divergence_acknowledgements): once an admin has
-- reviewed and accepted a recomputed cost, it stops being an open alert, while
-- a genuinely new divergence (different input_hash) still surfaces.
--
-- Read-only reporting change plus the ack exclusion; no ledger rows are touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_get_pricing_quality_v1(p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_published_id uuid;
BEGIN
  PERFORM _promote_due_pricing_versions(p_environment);
  SELECT id INTO v_published_id FROM ai_pricing_versions WHERE environment = p_environment AND state = 'published';

  RETURN jsonb_build_object(
    'models_without_rate', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('provider', provider, 'model', model, 'event_count', cnt))
      FROM (
        SELECT e.provider, e.model, COUNT(*) AS cnt
        FROM ai_usage_events e
        WHERE e.is_billable
          AND e.status = 'succeeded'
          AND e.cost_status IS DISTINCT FROM 'calculated'
          AND e.provider IS NOT NULL AND e.model IS NOT NULL
          AND e.started_at > now() - interval '30 days'
        GROUP BY e.provider, e.model
        ORDER BY COUNT(*) DESC LIMIT 25
      ) t
    ), '[]'::jsonb),
    'unpriced_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      WHERE e.is_billable
        AND e.status = 'succeeded'
        AND e.cost_status IS DISTINCT FROM 'calculated'
        AND e.started_at > now() - interval '30 days'
    ),
    'ambiguous_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      JOIN LATERAL (
        SELECT status FROM ai_cost_valuations v WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
      ) latest ON true
      WHERE e.started_at > now() - interval '30 days'
        AND latest.status = 'ambiguous_rate'
    ),
    'unused_rates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'provider', r.provider, 'model', r.model, 'metric_key', r.metric_key))
      FROM ai_pricing_rates r
      WHERE r.version_id = v_published_id
        AND NOT EXISTS (
          SELECT 1 FROM ai_cost_valuations v
          WHERE v.pricing_version_id = r.version_id
            AND v.components @> jsonb_build_array(jsonb_build_object('rateId', r.id::text))
        )
      LIMIT 50
    ), '[]'::jsonb),
    'unconfirmed_versions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', v.id, 'version_number', v.version_number, 'config_hash', v.config_hash))
      FROM ai_pricing_versions v
      WHERE v.environment = p_environment AND v.state = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM ai_pricing_acknowledgements a
          WHERE a.environment = p_environment AND a.hash_applied = v.config_hash
        )
    ), '[]'::jsonb),
    'divergent_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      JOIN LATERAL (
        SELECT id, input_hash, divergence_status
        FROM ai_cost_valuations v WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
      ) latest ON true
      WHERE e.started_at > now() - interval '30 days'
        AND latest.divergence_status = 'divergent'
        AND NOT EXISTS (
          SELECT 1 FROM ai_cost_divergence_acks a
          WHERE a.event_id = e.id AND a.input_hash = latest.input_hash
        )
    )
  );
END;
$function$;
