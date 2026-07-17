-- =============================================================================
-- MIGRATION: 20260717100000_ai_gateway_provider_pricing_gpt4o_mini
-- Projeto: Lemon (english learning app)
--
-- Etapa 6 do AI Gateway: cadastra os preços versionados do GPT-4o mini
-- (API normal, Chat Completions) usados para calcular calculated_cost_usd
-- em ai_usage_event_metrics / ai_usage_events.
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Nenhuma coluna é criada, removida ou renomeada.
--   • Nenhum dado existente é alterado ou apagado.
--   • Nenhum evento em ai_usage_events é tocado.
--   • Idempotente: pode rodar mais de uma vez sem duplicar preços
--     (guarda via NOT EXISTS — provider_pricing não tem unique constraint
--     natural além do id, então a idempotência é garantida aqui, não no
--     schema).
--
-- Auditoria do schema (Fase 1) — nenhuma estrutura nova foi necessária:
--   provider_pricing já representa tudo que a Etapa 6 precisa:
--     provider, service, model, metric_key, currency, unit_size,
--     price_per_unit, valid_from, valid_until, is_active, source_reference,
--     metadata.
--   Os nomes reais são valid_from/valid_until (não effective_from/to) e
--   NÃO existe uma coluna "channel" separada — o dado equivalente para
--   "API normal" (vs. Batch, que este schema ainda não distingue) é a
--   coluna service, já usada em ai_usage_events com o valor
--   'chat.completions' para as chamadas de writing.correct /
--   writing.explain_grammar.
--   Versionamento futuro não precisa de coluna nova: uma mudança de preço
--   deve encerrar a linha vigente (UPDATE valid_until) e inserir uma nova
--   linha com o novo valid_from — valid_from/valid_until já resolvem isso.
--
-- Fonte oficial, verificada em 2026-07-17:
--   https://developers.openai.com/api/docs/models/gpt-4o-mini
--   GPT-4o mini, API normal (Chat Completions):
--     input_text_tokens    USD 0.15  por 1.000.000 tokens
--     cached_input_tokens  USD 0.075 por 1.000.000 tokens
--     output_text_tokens   USD 0.60  por 1.000.000 tokens
--   provider_requests não tem cobrança adicional em Chat Completions —
--   nenhuma linha de preço é criada para essa métrica (ela permanece
--   is_billable = false, custo confirmado zero, tratado em código).
--
-- Precisão: price_per_unit é NUMERIC (precisão arbitrária no Postgres),
-- portanto 0.15 / 0.075 / 0.60 são armazenados exatamente, sem perda.
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
      'openai', 'chat.completions', 'gpt-4o-mini', 'input_text_tokens', 'USD',
      1000000::numeric, 0.15::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-4o-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'chat.completions', 'gpt-4o-mini', 'cached_input_tokens', 'USD',
      1000000::numeric, 0.075::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-4o-mini (verificado 2026-07-17)'
    ),
    (
      'openai', 'chat.completions', 'gpt-4o-mini', 'output_text_tokens', 'USD',
      1000000::numeric, 0.60::numeric,
      TIMESTAMPTZ '2026-07-17 00:00:00+00',
      'https://developers.openai.com/api/docs/models/gpt-4o-mini (verificado 2026-07-17)'
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
    AND model    = 'gpt-4o-mini'
    AND currency = 'USD'
    AND is_active = TRUE
    AND valid_until IS NULL
    AND metric_key IN ('input_text_tokens', 'cached_input_tokens', 'output_text_tokens');

  IF v_count <> 3 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 3 active gpt-4o-mini prices, got %', v_count;
  END IF;

  -- Nenhum preço faturável foi criado para provider_requests.
  IF EXISTS (
    SELECT 1 FROM public.provider_pricing
    WHERE provider = 'openai' AND model = 'gpt-4o-mini' AND metric_key = 'provider_requests'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_requests must not have a price row';
  END IF;
END $$;

COMMIT;
