-- =============================================================================
-- MIGRATION: 20260721000000_ai_gateway_provider_pricing_tts_and_azure_speech
-- Projeto: Lemon (english learning app)
--
-- Etapa 11 (fechamento de blockers missing_price) — cadastra os preços
-- versionados que faltavam para as 6 features apontadas pelo preflight
-- (scripts/ai-gateway-enforce-preflight.ts) com blocker missing_price:
--   conversation.preview_tts            (openai, tts-1)
--   tts.synthesize                      (azure,  tts_rest)
--   listening.story_session_tts         (azure,  tts_rest)
--   listening.two_part_tts              (azure,  tts_rest)
--   listening.episode_synthesize_audio  (azure,  tts_sdk)
--   pronunciation.assess_text           (azure,  pronunciation_assessment_sdk)
--
-- Auditoria do provider/service/model/metric_key real (Fase 1) —
-- confirmado por leitura direta dos call sites, não presumido:
--   api/conversation/[...slug].ts:120   → featureKey 'conversation.preview_tts',
--     provider 'openai', service 'audio.speech', model 'tts-1',
--     estimateTtsCharacters() → metricKey 'tts_characters'.
--   api/tts.ts:157                      → featureKey 'tts.synthesize',
--     provider 'azure', service 'tts_rest', model NULL (Azure não usa
--     coluna model para REST TTS), metricKey 'tts_characters'.
--   src/services/listening/story-session/generate-story-session.ts:277
--     → featureKey 'listening.story_session_tts', provider 'azure',
--       service 'tts_rest', metricKey 'tts_characters'.
--   src/services/listening/story-session/generate-listening-story.ts:407
--     → featureKey 'listening.two_part_tts', provider 'azure',
--       service 'tts_rest', metricKey 'tts_characters'.
--   src/services/listening/audio/synthesize-listening-block.ts:355
--     → featureKey 'listening.episode_synthesize_audio', provider 'azure',
--       service 'tts_sdk' (via microsoft-cognitiveservices-speech-sdk, não
--       REST — service distinto de tts_rest embora o metric e o preço por
--       caractere sejam idênticos), metricKey 'tts_characters'.
--   api/pronunciation/[...slug].ts:186-201 → featureKey
--     'pronunciation.assess_text', provider 'azure', service
--     'pronunciation_assessment_sdk', metricKey 'audio_seconds' (única
--     métrica faturável registrada — provider_requests é is_billable=false).
--
-- Fonte oficial e unidade faturada real, verificadas em 2026-07-21:
--   OpenAI tts-1: https://developers.openai.com/api/docs/models/tts-1
--     USD 15.00 por 1.000.000 caracteres (classic TTS, tts-1 — não
--     confundir com tts-1-hd a USD 30.00/1M, modelo não usado aqui).
--   Azure AI Speech: página de preços oficial
--     https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
--     não pôde ser renderizada por fetch automatizado nesta sessão (timeout
--     — página client-side-heavy); os valores abaixo foram cross-verificados
--     diretamente na Azure Retail Prices API oficial (mesma fonte de dados
--     que alimenta a página acima), consultada ao vivo em 2026-07-21:
--       GET https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview
--         &$filter=productName eq 'Azure Speech' and armRegionName eq 'eastus'
--     Meters retornados (region 'Global'/'eastus', tier S1 — pay-as-you-go
--     comercial, sem desconto de commitment tier):
--       "S1 Neural Text To Speech Characters"      USD 15.00 / 1,000,000 chars
--       "S1 Speech To Text"                        USD  1.00 / hour
--       "S1 Speech to Text Enhanced Feature Audio" USD  0.30 / hour
--     Neural TTS (character-billed) é o mesmo meter/preço independente do
--     transporte de API (REST em tts_rest, SDK em tts_sdk) — por isso as
--     três linhas 'tts_rest'/'tts_sdk' abaixo usam o preço idêntico, cada
--     uma com sua própria linha porque o lookup real
--     (api/_ai-gateway/pricing-repository.ts) casa provider+service+model+
--     metric_key exatamente, e service difere entre as duas.
--   Pronunciation Assessment (real-time) é faturado como Speech-to-Text
--     Standard (USD 1.00/hora) MAIS o add-on "Enhanced Feature" (USD
--     0.30/hora) exigido pela feature de pronúncia — confirmado tanto pela
--     Retail Prices API (os dois meters acima) quanto pela documentação
--     pública sobre add-ons "Enhanced" do Speech-to-Text em tempo real.
--     O código só registra UMA métrica faturável para esta feature
--     (audio_seconds — ver api/pronunciation/[...slug].ts), então o preço
--     efetivo combinado (1.00 + 0.30 = USD 1.30/hora) é registrado como uma
--     única linha, não dividido em duas métricas que o código não produz.
--
-- Conversão de unidade: todas as métricas de áudio neste arquivo já chegam
-- normalizadas na MESMA unidade usada tanto na estimativa pré-chamada
-- (api/_ai-gateway/estimators.ts: estimateTtsCharacters → caracteres exatos
-- da SSML/texto realmente enviado; estimateAudioSecondsCeiling → segundos)
-- quanto no evento físico realmente registrado — nenhuma conversão
-- adicional acontece em runtime, então usar unit_size=3600 (segundos por
-- hora) para audio_seconds e unit_size=1000000 (caracteres por milhão) para
-- tts_characters faz calculateLineCostUsd (quantity * price_per_unit /
-- unit_size — api/_ai-gateway/decimal.ts) operar diretamente sobre a
-- unidade nativa do preço oficial, sem passo de conversão que pudesse
-- divergir entre custo estimado e custo efetivo.
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Nenhuma coluna é criada, removida ou renomeada.
--   • Nenhum dado existente é alterado ou apagado.
--   • Nenhum evento em ai_usage_events é tocado.
--   • Idempotente: guarda via NOT EXISTS, mesmo padrão das migrations
--     20260717100000 / 20260717120000 / 20260717150000.
--
-- Precisão: price_per_unit é NUMERIC (precisão arbitrária no Postgres),
-- portanto 15.00 / 1.00 / 0.30 / 1.30 são armazenados exatamente, sem perda.
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
      'openai', 'audio.speech', 'tts-1', 'tts_characters', 'USD',
      1000000::numeric, 15.00::numeric,
      TIMESTAMPTZ '2026-07-21 00:00:00+00',
      'https://developers.openai.com/api/docs/models/tts-1 (verificado 2026-07-21)'
    ),
    (
      'azure', 'tts_rest', NULL, 'tts_characters', 'USD',
      1000000::numeric, 15.00::numeric,
      TIMESTAMPTZ '2026-07-21 00:00:00+00',
      'https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/ ' ||
      '— valor cross-verificado ao vivo via Azure Retail Prices API (meter "S1 Neural Text To Speech Characters", region Global), 2026-07-21'
    ),
    (
      'azure', 'tts_sdk', NULL, 'tts_characters', 'USD',
      1000000::numeric, 15.00::numeric,
      TIMESTAMPTZ '2026-07-21 00:00:00+00',
      'https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/ ' ||
      '— valor cross-verificado ao vivo via Azure Retail Prices API (meter "S1 Neural Text To Speech Characters", region Global), 2026-07-21'
    ),
    (
      'azure', 'pronunciation_assessment_sdk', NULL, 'audio_seconds', 'USD',
      3600::numeric, 1.30::numeric,
      TIMESTAMPTZ '2026-07-21 00:00:00+00',
      'https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/ ' ||
      '— valor cross-verificado ao vivo via Azure Retail Prices API (meters "S1 Speech To Text" USD 1.00/hora + "S1 Speech to Text Enhanced Feature Audio" USD 0.30/hora, region Global/eastus), 2026-07-21'
    )
) AS v(provider, service, model, metric_key, currency, unit_size, price_per_unit, valid_from, source_reference)
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_pricing pp
  WHERE pp.provider   = v.provider
    AND pp.service     = v.service
    AND pp.model       IS NOT DISTINCT FROM v.model
    AND pp.metric_key  = v.metric_key
    AND pp.currency    = v.currency
    AND pp.valid_from  = v.valid_from
);

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================
-- Falha atomicamente (rollback da transação) se as quatro linhas não
-- tiverem sido cadastradas exatamente como esperado.

DO $$
DECLARE
  v_count NUMERIC;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.provider_pricing
  WHERE currency = 'USD'
    AND is_active = TRUE
    AND valid_until IS NULL
    AND (
      (provider = 'openai' AND service = 'audio.speech' AND model = 'tts-1' AND metric_key = 'tts_characters' AND price_per_unit = 15.00 AND unit_size = 1000000)
      OR (provider = 'azure' AND service = 'tts_rest' AND model IS NULL AND metric_key = 'tts_characters' AND price_per_unit = 15.00 AND unit_size = 1000000)
      OR (provider = 'azure' AND service = 'tts_sdk' AND model IS NULL AND metric_key = 'tts_characters' AND price_per_unit = 15.00 AND unit_size = 1000000)
      OR (provider = 'azure' AND service = 'pronunciation_assessment_sdk' AND model IS NULL AND metric_key = 'audio_seconds' AND price_per_unit = 1.30 AND unit_size = 3600)
    );

  IF v_count <> 4 THEN
    RAISE EXCEPTION 'VALIDATION FAILED: expected 4 active prices (tts-1/tts_rest/tts_sdk/pronunciation_assessment_sdk), got %', v_count;
  END IF;

  -- Nenhum preço faturável foi criado para provider_requests (nunca
  -- faturado à parte para nenhuma destas features).
  IF EXISTS (
    SELECT 1 FROM public.provider_pricing
    WHERE (
      (provider = 'openai' AND service = 'audio.speech' AND model = 'tts-1')
      OR (provider = 'azure' AND service IN ('tts_rest', 'tts_sdk', 'pronunciation_assessment_sdk'))
    )
    AND metric_key = 'provider_requests'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: provider_requests must not have a price row';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260721000000_ai_gateway_provider_pricing_tts_and_azure_speech
-- =============================================================================
