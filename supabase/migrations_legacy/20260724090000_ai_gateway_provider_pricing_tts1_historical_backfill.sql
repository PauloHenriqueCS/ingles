-- =============================================================================
-- MIGRATION: 20260724090000_ai_gateway_provider_pricing_tts1_historical_backfill
-- Projeto: Lemon (english learning app)
--
-- Auditoria de custo (2026-07-24) encontrou 1 evento real (id
-- 9ac36a9d-1a08-4290-8083-4722ea18793e, feature conversation.preview_tts,
-- started_at 2026-07-18 03:34:19 UTC) cuja métrica billable tts_characters
-- (openai/audio.speech/tts-1) ficou sem pricing_id: a única linha de
-- provider_pricing para essa combinação (id
-- 11f92a13-85e3-46e1-982c-cee26d351766) só existe a partir de
-- valid_from=2026-07-21 00:00:00+00 (criada em 2026-07-21 21:27:34+00,
-- migration 20260721000000) — 3 dias DEPOIS do evento. Não é atraso de
-- reconciliação: não existia nenhuma tarifa cobrindo esse timestamp.
--
-- O preço oficial do OpenAI tts-1 (USD 15.00 / 1.000.000 caracteres,
-- verificado em 2026-07-21 — ver header da migration 20260721000000) não
-- mudou nesse intervalo; o gap é só de cadastro, não de tarifa real. Esta
-- migration fecha esse gap retroativamente com uma segunda linha para o
-- MESMO preço, valida a partir de 2026-07-17 00:00:00+00 — a mesma
-- data-base usada nas demais tarifas OpenAI já cadastradas
-- (20260717100000/20260717120000/20260717150000, quando o catálogo de
-- preços do Gateway passou a existir) — e válida até exatamente o
-- valid_from da linha vigente, para não deixar gap nem sobreposição:
--   [2026-07-17 00:00:00Z, 2026-07-21 00:00:00Z)  → esta linha (histórica)
--   [2026-07-21 00:00:00Z, ∞)                      → linha vigente (inalterada)
-- api/_ai-gateway/pricing-repository.ts:52-53 usa valid_from<=at E
-- (valid_until IS NULL OR valid_until>at) — um evento em exatamente
-- 2026-07-21T00:00:00Z casa com a linha vigente (valid_from<=at), nunca com
-- as duas.
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Não altera, sobrepõe ou desativa a linha vigente
--     (11f92a13-85e3-46e1-982c-cee26d351766) iniciada em 2026-07-21.
--   • Nenhuma coluna é criada, removida ou renomeada.
--   • Nenhum evento em ai_usage_events/ai_usage_event_metrics é tocado
--     (a reconciliação do evento 9ac36a9d é feita à parte, via
--     scripts/ai-gateway-reconcile-event.ts, reaproveitando o motor real
--     reconcileEventCost — nunca por UPDATE manual de custo).
--   • Idempotente: guarda via NOT EXISTS, mesmo padrão de
--     20260721000000_ai_gateway_provider_pricing_tts_and_azure_speech.
-- =============================================================================

BEGIN;

INSERT INTO public.provider_pricing (
  provider, service, model, region, metric_key, currency,
  unit_size, price_per_unit,
  valid_from, valid_until, is_active,
  source_reference, metadata
)
SELECT 'openai', 'audio.speech', 'tts-1', NULL, 'tts_characters', 'USD',
       1000000::numeric, 15.00::numeric,
       TIMESTAMPTZ '2026-07-17 00:00:00+00',
       TIMESTAMPTZ '2026-07-21 00:00:00+00',
       TRUE,
       'https://developers.openai.com/api/docs/models/tts-1 — backfill retroativo do gap de cadastro identificado na auditoria de custo de 2026-07-24; mesmo preço verificado em 2026-07-21 (migration 20260721000000), sem mudança de tarifa real, só de data de cadastro',
       '{"backfill_reason": "retroactive_catalog_gap", "audited_event_id": "9ac36a9d-1a08-4290-8083-4722ea18793e"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_pricing pp
  WHERE pp.provider    = 'openai'
    AND pp.service      = 'audio.speech'
    AND pp.model        = 'tts-1'
    AND pp.metric_key   = 'tts_characters'
    AND pp.currency     = 'USD'
    AND pp.valid_from   = TIMESTAMPTZ '2026-07-17 00:00:00+00'
);

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- Falha atomicamente se a linha histórica não existir exatamente como
-- esperado, ou se a linha vigente (2026-07-21) tiver sido alterada.

DO $$
DECLARE
  v_historical_count INTEGER;
  v_current_valid_from TIMESTAMPTZ;
  v_current_price NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_historical_count
  FROM public.provider_pricing
  WHERE provider = 'openai' AND service = 'audio.speech' AND model = 'tts-1'
    AND metric_key = 'tts_characters' AND currency = 'USD'
    AND valid_from = TIMESTAMPTZ '2026-07-17 00:00:00+00'
    AND valid_until = TIMESTAMPTZ '2026-07-21 00:00:00+00'
    AND price_per_unit = 15.00 AND unit_size = 1000000 AND is_active = TRUE;

  IF v_historical_count <> 1 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected exactly 1 historical tts-1 tariff row [2026-07-17,2026-07-21), got %', v_historical_count;
  END IF;

  SELECT valid_from, price_per_unit INTO v_current_valid_from, v_current_price
  FROM public.provider_pricing
  WHERE id = '11f92a13-85e3-46e1-982c-cee26d351766';

  IF v_current_valid_from IS DISTINCT FROM TIMESTAMPTZ '2026-07-21 00:00:00+00' OR v_current_price IS DISTINCT FROM 15.00 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: the currently-active tts-1 tariff row (id 11f92a13-...) was modified — this migration must be purely additive';
  END IF;

  -- Garante que as duas janelas de vigência não se sobrepõem nem deixam gap.
  IF EXISTS (
    SELECT 1 FROM public.provider_pricing
    WHERE provider = 'openai' AND service = 'audio.speech' AND model = 'tts-1'
      AND metric_key = 'tts_characters' AND currency = 'USD'
    GROUP BY provider, service, model, metric_key, currency
    HAVING COUNT(*) <> 2
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected exactly 2 tariff rows (historical + current) for openai/tts-1/tts_characters';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260724090000_ai_gateway_provider_pricing_tts1_historical_backfill
-- =============================================================================
