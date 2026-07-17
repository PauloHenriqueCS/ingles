-- =============================================================================
-- MIGRATION: 20260717110000_ai_gateway_daily_rollup
-- Projeto: Lemon (english learning app)
--
-- Etapa 7 do AI Gateway: pipeline idempotente que transforma ai_usage_events /
-- ai_usage_event_metrics (fonte da verdade, imutável) em resumos diários
-- (usage_daily / usage_daily_metrics — dados derivados, reconstruíveis) para
-- o futuro dashboard em ingles-dashboard (não alterado aqui).
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Nenhuma coluna, tabela ou índice existente é removido ou renomeado.
--   • Nenhum dado existente é alterado ou apagado.
--   • Nenhum evento em ai_usage_events é tocado.
--   • Idempotente: ADD COLUMN IF NOT EXISTS, constraints guardadas por
--     verificação em pg_constraint, funções via CREATE OR REPLACE.
--
-- Auditoria do schema (Fase 1) — usage_daily e usage_daily_metrics já
-- existiam (BLOCO 9/10 da migration 20260717000000), vazias, sem agregação
-- implementada:
--
--   usage_daily já separa corretamente o grão em
--     (usage_date, user_id, actor_type, feature_key, provider, model),
--   com um índice UNIQUE que já trata user_id/model NULL via COALESCE em
--   sentinela — uq_usage_daily_composite. Não há coluna "service": decisão
--   deliberada de NÃO adicionar uma, porque (a) feature_key já é parte do
--   grão e, na prática, cada feature_key usa um único service estável hoje;
--   (b) a própria lista de "nunca pode misturar" da Etapa 7 não inclui
--   service. Se um dia uma feature passar a usar múltiplos services, isso
--   se torna indispensável e vira uma migration adicional — não inventado
--   agora sem necessidade real.
--
--   usage_daily_metrics já agrega genericamente por (metric_key, unit_type)
--   com total_quantity/billable_quantity/calculated_cost_usd — nenhuma
--   mudança estrutural necessária; já aceita qualquer metric_key futuro
--   (tts_characters, audio_seconds, etc.) sem alteração de schema.
--
--   Colunas indispensáveis que NÃO existiam e foram adicionadas aqui:
--     distinct_logical_requests — contagem de correlation_id distintos
--       (mais eventos sem correlation_id, cada um contado como sua própria
--       requisição lógica). Não havia equivalente.
--     total_latency_ms — soma de ai_usage_events.latency_ms no bucket.
--       Optou-se por SOMA (não média): recalculável a partir do zero a
--       cada rebuild sem estado intermediário; média = total/total_requests,
--       calculável pelo dashboard sem precisar de outra coluna.
--     last_rebuilt_at — timestamp explícito da última reconstrução bem-
--       sucedida do bucket, distinto de updated_at (que dispara em
--       qualquer UPDATE, não necessariamente um rebuild completo).
--
-- Sem migration nova: unpriced_events, calculated_cost_usd, cache_hits,
-- successful_requests, failed_requests, blocked_requests, total_requests,
-- last_event_at já existiam e são exatamente os nomes usados abaixo.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: colunas adicionais em usage_daily
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.usage_daily
  ADD COLUMN IF NOT EXISTS distinct_logical_requests BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_latency_ms          BIGINT,
  ADD COLUMN IF NOT EXISTS last_rebuilt_at            TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ud_distinct_logical_requests_non_negative') THEN
    ALTER TABLE public.usage_daily
      ADD CONSTRAINT chk_ud_distinct_logical_requests_non_negative CHECK (distinct_logical_requests >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ud_total_latency_ms_non_negative') THEN
    ALTER TABLE public.usage_daily
      ADD CONSTRAINT chk_ud_total_latency_ms_non_negative CHECK (total_latency_ms IS NULL OR total_latency_ms >= 0);
  END IF;
END $$;

-- No new column and no data touches usage_daily_metrics — its existing
-- shape (usage_daily_id, metric_key, unit_type, total_quantity,
-- billable_quantity, calculated_cost_usd) is already fully generic.

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: rebuild_usage_daily_bucket — full recompute of one bucket, atomic
-- ─────────────────────────────────────────────────────────────────────────────
-- Server-only (service_role). Never accepts a price, cost, or dimension the
-- caller invents beyond the bucket's identity — everything else is derived
-- fresh from ai_usage_events / ai_usage_event_metrics on every call.
--
-- Always a FULL recompute (SUM/COUNT from scratch), never an increment —
-- this is what makes re-running it, or running it concurrently, safe.
-- A transaction-scoped advisory lock serializes concurrent rebuilds of the
-- exact same bucket so the last one to commit always reflects every event
-- confirmed by that point; it is released automatically at COMMIT/ROLLBACK.

CREATE OR REPLACE FUNCTION public.rebuild_usage_daily_bucket(
  p_usage_date  DATE,
  p_user_id     UUID,
  p_actor_type  TEXT,
  p_feature_key TEXT,
  p_provider    TEXT,
  p_model       TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lock_key       BIGINT;
  v_usage_daily_id UUID;
BEGIN
  v_lock_key := hashtextextended(
    p_usage_date::TEXT || '|' ||
    COALESCE(p_user_id::TEXT, '00000000-0000-0000-0000-000000000000') || '|' ||
    p_actor_type || '|' || p_feature_key || '|' || p_provider || '|' || COALESCE(p_model, ''),
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  WITH bucket_events AS (
    SELECT e.*
    FROM public.ai_usage_events e
    WHERE DATE(e.started_at AT TIME ZONE 'UTC') = p_usage_date
      AND COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
          = COALESCE(p_user_id::TEXT, '00000000-0000-0000-0000-000000000000')
      AND e.actor_type  = p_actor_type
      AND e.feature_key = p_feature_key
      AND e.provider    = p_provider
      AND COALESCE(e.model, '') = COALESCE(p_model, '')
  ),
  agg AS (
    SELECT
      COUNT(*)                                                       AS total_requests,
      COUNT(*) FILTER (WHERE status = 'succeeded')                   AS successful_requests,
      COUNT(*) FILTER (WHERE status = 'failed')                      AS failed_requests,
      COUNT(*) FILTER (WHERE status = 'blocked')                     AS blocked_requests,
      COUNT(*) FILTER (WHERE cache_hit)                              AS cache_hits,
      -- pending/unpriced: any cost_status not yet resolved to a final state.
      -- Non-billable events are always 'not_applicable' from creation, so
      -- they never appear here — no separate is_billable check needed.
      COUNT(*) FILTER (WHERE cost_status NOT IN ('calculated', 'reconciled', 'not_applicable')) AS unpriced_events,
      -- Logical requests: one per distinct correlation_id, plus one for
      -- each event that has no correlation_id at all (never merged).
      COUNT(DISTINCT correlation_id) FILTER (WHERE correlation_id IS NOT NULL) AS distinct_correlation_requests,
      COUNT(*) FILTER (WHERE correlation_id IS NULL)                  AS requests_without_correlation,
      COALESCE(SUM(latency_ms), 0)                                   AS total_latency_ms,
      -- NULL calculated_cost_usd (unknown) is never treated as 0 — only
      -- non-NULL values are summed; a bucket with zero priced events
      -- correctly sums to 0, not to "we don't know".
      COALESCE(SUM(calculated_cost_usd) FILTER (WHERE calculated_cost_usd IS NOT NULL), 0) AS calculated_cost_usd,
      MAX(started_at)                                                AS last_event_at
    FROM bucket_events
  )
  INSERT INTO public.usage_daily (
    usage_date, user_id, actor_type, feature_key, provider, model,
    total_requests, successful_requests, failed_requests, blocked_requests,
    cache_hits, unpriced_events, distinct_logical_requests,
    estimated_cost_usd, calculated_cost_usd, reconciled_cost_usd,
    total_latency_ms, last_event_at, last_rebuilt_at
  )
  SELECT
    p_usage_date, p_user_id, p_actor_type, p_feature_key, p_provider, p_model,
    agg.total_requests, agg.successful_requests, agg.failed_requests, agg.blocked_requests,
    agg.cache_hits, agg.unpriced_events,
    agg.distinct_correlation_requests + agg.requests_without_correlation,
    0, agg.calculated_cost_usd, 0,
    agg.total_latency_ms, agg.last_event_at, NOW()
  FROM agg
  ON CONFLICT (usage_date, COALESCE(user_id::TEXT, '00000000-0000-0000-0000-000000000000'), actor_type, feature_key, provider, COALESCE(model, ''))
  DO UPDATE SET
    total_requests             = EXCLUDED.total_requests,
    successful_requests        = EXCLUDED.successful_requests,
    failed_requests             = EXCLUDED.failed_requests,
    blocked_requests            = EXCLUDED.blocked_requests,
    cache_hits                  = EXCLUDED.cache_hits,
    unpriced_events              = EXCLUDED.unpriced_events,
    distinct_logical_requests    = EXCLUDED.distinct_logical_requests,
    estimated_cost_usd           = EXCLUDED.estimated_cost_usd,
    calculated_cost_usd          = EXCLUDED.calculated_cost_usd,
    reconciled_cost_usd          = EXCLUDED.reconciled_cost_usd,
    total_latency_ms             = EXCLUDED.total_latency_ms,
    last_event_at                = EXCLUDED.last_event_at,
    last_rebuilt_at               = EXCLUDED.last_rebuilt_at
  RETURNING id INTO v_usage_daily_id;

  WITH bucket_events AS (
    SELECT e.id
    FROM public.ai_usage_events e
    WHERE DATE(e.started_at AT TIME ZONE 'UTC') = p_usage_date
      AND COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
          = COALESCE(p_user_id::TEXT, '00000000-0000-0000-0000-000000000000')
      AND e.actor_type  = p_actor_type
      AND e.feature_key = p_feature_key
      AND e.provider    = p_provider
      AND COALESCE(e.model, '') = COALESCE(p_model, '')
  ),
  metric_agg AS (
    SELECT
      m.metric_key,
      m.unit_type,
      SUM(m.quantity)                                    AS total_quantity,
      SUM(COALESCE(m.billable_quantity, 0))               AS billable_quantity,
      SUM(COALESCE(m.calculated_cost_usd, 0))             AS calculated_cost_usd
    FROM public.ai_usage_event_metrics m
    JOIN bucket_events be ON be.id = m.usage_event_id
    WHERE m.is_final = TRUE
    GROUP BY m.metric_key, m.unit_type
  ),
  ins AS (
    INSERT INTO public.usage_daily_metrics (
      usage_daily_id, metric_key, unit_type, total_quantity, billable_quantity, calculated_cost_usd
    )
    SELECT v_usage_daily_id, metric_key, unit_type, total_quantity, billable_quantity, calculated_cost_usd
    FROM metric_agg
    ON CONFLICT (usage_daily_id, metric_key, unit_type) DO UPDATE SET
      total_quantity      = EXCLUDED.total_quantity,
      billable_quantity   = EXCLUDED.billable_quantity,
      calculated_cost_usd = EXCLUDED.calculated_cost_usd
    RETURNING id
  )
  -- Full recompute means metric_key/unit_type combinations no longer present
  -- (should not normally happen — raw events are immutable) are dropped too,
  -- so the breakdown never carries stale rows forward.
  DELETE FROM public.usage_daily_metrics dm
  WHERE dm.usage_daily_id = v_usage_daily_id
    AND NOT EXISTS (
      SELECT 1 FROM metric_agg ma
      WHERE ma.metric_key = dm.metric_key AND ma.unit_type = dm.unit_type
    );

  RETURN v_usage_daily_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_usage_daily_bucket(DATE, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_usage_daily_bucket(DATE, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: rebuild_usage_daily_bucket_for_event — entrypoint por evento
-- ─────────────────────────────────────────────────────────────────────────────
-- Recebe SOMENTE o event id (nada enviado pelo cliente além disso). Resolve
-- as dimensões do bucket a partir do próprio evento em ai_usage_events e
-- delega para rebuild_usage_daily_bucket, que faz o trabalho atômico.

CREATE OR REPLACE FUNCTION public.rebuild_usage_daily_bucket_for_event(p_event_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event      RECORD;
  v_usage_date DATE;
BEGIN
  SELECT user_id, actor_type, feature_key, provider, model, started_at
  INTO v_event
  FROM public.ai_usage_events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rebuild_usage_daily_bucket_for_event: event % not found', p_event_id;
  END IF;

  v_usage_date := DATE(v_event.started_at AT TIME ZONE 'UTC');

  RETURN public.rebuild_usage_daily_bucket(
    v_usage_date, v_event.user_id, v_event.actor_type, v_event.feature_key, v_event.provider, v_event.model
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_usage_daily_bucket_for_event(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_usage_daily_bucket_for_event(UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: list_usage_daily_buckets_for_date — paginação para reconciliação
-- ─────────────────────────────────────────────────────────────────────────────
-- Usada apenas pela reconciliação de um dia inteiro (Fase 5). Retorna somente
-- as chaves de bucket (dimensões), nunca eventos brutos — mantém o
-- processamento por dia limitado em memória, paginável por bucket_key.

CREATE OR REPLACE FUNCTION public.list_usage_daily_buckets_for_date(
  p_usage_date DATE,
  p_limit      INT  DEFAULT 200,
  p_after_key  TEXT DEFAULT NULL
) RETURNS TABLE (
  bucket_key  TEXT,
  user_id     UUID,
  actor_type  TEXT,
  feature_key TEXT,
  provider    TEXT,
  model       TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT
    COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
      || '|' || e.actor_type || '|' || e.feature_key || '|' || e.provider || '|' || COALESCE(e.model, '') AS bucket_key,
    e.user_id, e.actor_type, e.feature_key, e.provider, e.model
  FROM public.ai_usage_events e
  WHERE DATE(e.started_at AT TIME ZONE 'UTC') = p_usage_date
    AND (
      p_after_key IS NULL
      OR (COALESCE(e.user_id::TEXT, '00000000-0000-0000-0000-000000000000')
          || '|' || e.actor_type || '|' || e.feature_key || '|' || e.provider || '|' || COALESCE(e.model, '')) > p_after_key
    )
  ORDER BY bucket_key
  LIMIT GREATEST(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION public.list_usage_daily_buckets_for_date(DATE, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_usage_daily_buckets_for_date(DATE, INT, TEXT) TO service_role;

COMMIT;
