-- =============================================================================
-- MIGRATION: 20260717150000_ai_gateway_provider_pricing_gpt_realtime_2_1_mini
-- Projeto: Lemon (english learning app)
--
-- Etapa 10 do AI Gateway: cadastra os preços versionados do gpt-realtime-2.1-mini
-- (OpenAI Realtime API) usados para calcular calculated_cost_usd em
-- ai_usage_event_metrics / ai_usage_events para a chave contábil
-- conversation.realtime_usage.
--
-- Auditoria do modelo real (Fase 1) — confirmado em
-- api/conversation/[...slug].ts:
--   const REALTIME_MODEL = (process.env.OPENAI_REALTIME_MODEL ?? '').trim()
--     || 'gpt-realtime-2.1-mini';
-- O default exato bate com o modelo autorizado nesta etapa. Se
-- OPENAI_REALTIME_MODEL for definida com outro valor em produção, os
-- eventos gravam esse outro model e simplesmente não encontram preço aqui —
-- cost_status permanece 'pending', nunca um valor inventado.
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Nenhuma coluna é criada, removida ou renomeada.
--   • Nenhum dado existente é alterado ou apagado.
--   • Nenhum evento em ai_usage_events é tocado.
--   • Idempotente: guarda via NOT EXISTS, mesmo padrão das migrations
--     20260717100000 / 20260717120000.
--
-- metric_key reaproveita o vocabulário já existente onde a semântica é
-- idêntica (Fase 7 — "adote nomes compatíveis com o catálogo atual"):
--   input_text_tokens / cached_input_tokens / output_text_tokens já
--   representam exatamente "tokens de texto, dos quais parte é cache" para
--   qualquer feature — o mesmo significado do input_token_details.text_tokens
--   / cached_tokens_details.text_tokens / output_token_details.text_tokens
--   do evento response.done do Realtime. Reaproveitar não cria ambiguidade:
--   a linha de preço é sempre filtrada por (provider, service, model,
--   metric_key), e o service 'realtime' distingue essas linhas das de
--   chat.completions mesmo com metric_key igual.
--   input_audio_tokens / output_audio_tokens já existiam no MetricKey.
--   cached_input_audio_tokens é a única chave nova (ver
--   api/_ai-gateway/types.ts) — o Realtime é a primeira feature com áudio
--   em cache.
--
-- Fonte oficial, verificada em 2026-07-17:
--   https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
--   gpt-realtime-2.1-mini (Realtime API), por 1.000.000 tokens, USD:
--     text input          0.60
--     cached text input   0.06
--     text output         2.40
--     audio input        10.00
--     cached audio input  0.30
--     audio output       20.00
--   provider_requests não recebe preço — is_billable = false para essa
--   métrica em conversation.realtime_usage, custo confirmado zero tratado
--   em código, igual às demais features do Gateway. session_seconds também
--   não recebe preço: é uma métrica de controle de duração para limites
--   futuros (Etapa 11), não um item de billing.
--
-- Precisão: price_per_unit é NUMERIC (precisão arbitrária no Postgres),
-- portanto 0.60 / 0.06 / 2.40 / 10.00 / 0.30 / 20.00 são armazenados
-- exatamente, sem perda.
-- =============================================================================

BEGIN;

INSERT INTO public.provider_pricing (
  provider, service, model, region, metric_key, currency,
  unit_size, price_per_unit,
  valid_from, valid_until, is_active,
  source_reference, metadata
)
SELECT v.provider, v.service, v.model, NULL, v.metric_key, v.currency,
       v.unit_size, v.price_per_unit,
       v.valid_from, NULL, TRUE,
       v.source_reference, '{}'::jsonb
FROM (
  VALUES
    (
      'openai', 'realtime', 'gpt-realtime-2.1-mini', 'input_text_tokens', 'USD',
      1000000::numeric, 0.60::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'realtime', 'gpt-realtime-2.1-mini', 'cached_input_tokens', 'USD',
      1000000::numeric, 0.06::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'realtime', 'gpt-realtime-2.1-mini', 'output_text_tokens', 'USD',
      1000000::numeric, 2.40::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'realtime', 'gpt-realtime-2.1-mini', 'input_audio_tokens', 'USD',
      1000000::numeric, 10.00::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'realtime', 'gpt-realtime-2.1-mini', 'cached_input_audio_tokens', 'USD',
      1000000::numeric, 0.30::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'realtime', 'gpt-realtime-2.1-mini', 'output_audio_tokens', 'USD',
      1000000::numeric, 20.00::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini (verificado 2026-07-17)'
    )
) AS v(provider, service, model, metric_key, currency, unit_size, price_per_unit, valid_from, source_reference)
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_pricing pp
  WHERE pp.provider   = v.provider
    AND pp.service     = v.service
    AND pp.model       = v.model
    AND pp.metric_key  = v.metric_key
    AND pp.currency    = v.currency
    AND pp.valid_from  = v.valid_from
);

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- Falha atomicamente (rollback da transação) se as seis linhas não tiverem
-- sido cadastradas exatamente como esperado.

DO $$
DECLARE
  v_count NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.provider_pricing
  WHERE provider = 'openai'
    AND service  = 'realtime'
    AND model    = 'gpt-realtime-2.1-mini'
    AND currency = 'USD'
    AND is_active = TRUE
    AND valid_until IS NULL
    AND metric_key IN (
      'input_text_tokens', 'cached_input_tokens', 'output_text_tokens',
      'input_audio_tokens', 'cached_input_audio_tokens', 'output_audio_tokens'
    );

  IF v_count <> 6 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 6 active gpt-realtime-2.1-mini prices, got %', v_count;
  END IF;

  -- Nenhum preço faturável foi criado para provider_requests ou session_seconds.
  IF EXISTS (
    SELECT 1 FROM public.provider_pricing
    WHERE provider = 'openai' AND model = 'gpt-realtime-2.1-mini'
      AND metric_key IN ('provider_requests', 'session_seconds')
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_requests/session_seconds must not have a price row';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260717150000_ai_gateway_provider_pricing_gpt_realtime_2_1_mini
-- =============================================================================
