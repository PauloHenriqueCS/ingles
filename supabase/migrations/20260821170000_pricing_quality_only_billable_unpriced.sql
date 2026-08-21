-- ============================================================================
-- Pricing quality: count only BILLABLE events as "sem preço".
-- ----------------------------------------------------------------------------
-- admin_get_pricing_quality_v1.unpriced_events_30d (and models_without_rate)
-- counted EVERY event lacking a 'calculated' valuation, including non-billable
-- control/session events (azure speech_sts, openai realtime.client_secrets /
-- realtime.webrtc, azure speech_sdk). Those have no cost by design, so they
-- were inflating "eventos sem preço no catálogo" (~167 of 169 were non-billable).
-- Add `AND e.is_billable` so the quality panel only flags billable events that
-- genuinely couldn't be priced. Read-only reporting change; no data touched.
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
          AND e.provider IS NOT NULL AND e.model IS NOT NULL
          AND e.started_at > now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM ai_pricing_rates r
            WHERE r.version_id = v_published_id AND r.provider = e.provider
              AND (r.model IS NULL OR r.model = e.model)
          )
        GROUP BY e.provider, e.model
        ORDER BY COUNT(*) DESC LIMIT 25
      ) t
    ), '[]'::jsonb),
    'unpriced_events_30d', (
      SELECT COUNT(*) FROM ai_usage_events e
      WHERE e.is_billable
        AND e.started_at > now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM ai_cost_valuations v WHERE v.event_id = e.id AND v.status = 'calculated'
        )
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
        SELECT divergence_status FROM ai_cost_valuations v WHERE v.event_id = e.id ORDER BY v.created_at DESC LIMIT 1
      ) latest ON true
      WHERE e.started_at > now() - interval '30 days'
        AND latest.divergence_status = 'divergent'
    )
  );
END;
$function$;
