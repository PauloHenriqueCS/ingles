-- =============================================================================
-- MIGRATION: 20260717120000_ai_gateway_provider_pricing_gpt4o
-- Projeto: Lemon (english learning app)
--
-- Etapa 8D do AI Gateway: cadastra os preços versionados do GPT-4o (API
-- normal, Chat Completions) usados para calcular calculated_cost_usd em
-- ai_usage_event_metrics / ai_usage_events.
--
-- Justificativa de elegibilidade (Fase 0 da Etapa 8D):
--   listening.episode_generate_story (src/services/listening/generate-listening-story.ts,
--   createDefaultAICallFn) é um fluxo ativo — acionado tanto pelo job de
--   sistema GENERATE_LISTENING_STORY (src/services/listening/jobs/listening-job-handlers.ts)
--   quanto pelo pipeline on-demand (src/services/listening/on-demand/process-listening-generation-step.ts,
--   stepGeneratingBlock1) — e usa exatamente o modelo 'gpt-4o' (constante
--   AI_MODEL, sem snapshot de data) com service 'chat.completions'.
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Nenhuma coluna é criada, removida ou renomeada.
--   • Nenhum dado existente é alterado ou apagado (nenhuma linha do
--     gpt-4o-mini cadastrada em 20260717100000 é tocada).
--   • Nenhum evento em ai_usage_events é tocado.
--   • Idempotente: pode rodar mais de uma vez sem duplicar preços
--     (guarda via NOT EXISTS, mesmo padrão da migration do gpt-4o-mini).
--
-- Fonte oficial, verificada em 2026-07-17:
--   https://developers.openai.com/api/docs/models/gpt-4o
--   GPT-4o, API normal (Chat Completions):
--     input_text_tokens    USD 2.50  por 1.000.000 tokens
--     cached_input_tokens  USD 1.25  por 1.000.000 tokens
--     output_text_tokens   USD 10.00 por 1.000.000 tokens
--   provider_requests não tem cobrança adicional em Chat Completions —
--   nenhuma linha de preço é criada para essa métrica (ela permanece
--   is_billable = false, custo confirmado zero, tratado em código).
--
-- Precisão: price_per_unit é NUMERIC (precisão arbitrária no Postgres),
-- portanto 2.50 / 1.25 / 10.00 são armazenados exatamente, sem perda.
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
      'openai', 'chat.completions', 'gpt-4o', 'input_text_tokens', 'USD',
      1000000::numeric, 2.50::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-4o (verificado 2026-07-17)'
    ),
    (
      'openai', 'chat.completions', 'gpt-4o', 'cached_input_tokens', 'USD',
      1000000::numeric, 1.25::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-4o (verificado 2026-07-17)'
    ),
    (
      'openai', 'chat.completions', 'gpt-4o', 'output_text_tokens', 'USD',
      1000000::numeric, 10.00::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-4o (verificado 2026-07-17)'
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
-- Falha atomicamente (rollback da transação) se os três preços não tiverem
-- sido cadastrados exatamente como esperado.

DO $$
DECLARE
  v_count NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.provider_pricing
  WHERE provider = 'openai'
    AND service  = 'chat.completions'
    AND model    = 'gpt-4o'
    AND currency = 'USD'
    AND is_active = TRUE
    AND valid_until IS NULL
    AND metric_key IN ('input_text_tokens', 'cached_input_tokens', 'output_text_tokens');

  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 3 active gpt-4o prices, got %', v_count;
  END IF;

  -- Nenhum preço faturável foi criado para provider_requests.
  IF EXISTS (
    SELECT 1 FROM public.provider_pricing
    WHERE provider = 'openai' AND model = 'gpt-4o' AND metric_key = 'provider_requests'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_requests must not have a price row';
  END IF;

  -- gpt-4o-mini não pode ter sido alterado por esta migration.
  IF (
    SELECT COUNT(*) FROM public.provider_pricing
    WHERE provider = 'openai' AND model = 'gpt-4o-mini' AND is_active = TRUE AND valid_until IS NULL
  ) <> 3 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: gpt-4o-mini pricing rows were unexpectedly affected';
  END IF;
END $$;

COMMIT;
