-- =============================================================================
-- MIGRATION: 20260812220000_gpt4o_mini_tts_preview_pricing
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/deploy-production.yml
-- (supabase db push) após o merge na main, e por homologation.yml em develop.
-- Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO: registrar o preço de openai/audio.speech/gpt-4o-mini-tts para o
-- metric tts_characters. O preview de vozes (conversation.preview_tts) passou a
-- usar gpt-4o-mini-tts (o tts-1 rejeitava as vozes novas com HTTP 400). Sem uma
-- linha de pricing, os eventos de custo desse feature ficariam "pending"
-- (não-reconciliados) — não quebra a chamada, mas prejudica a observabilidade.
--
-- PREÇO: espelha CONSERVADORAMENTE o tts-1 (US$ 15,00 / 1.000.000 caracteres).
-- gpt-4o-mini-tts é, na prática, MAIS BARATO que o tts-1, então esta tarifa
-- nunca subestima o orçamento (over-estimate seguro). O volume é mínimo — as
-- amostras são cacheadas no bucket compartilhado (voice-previews/), geradas no
-- máximo uma vez por voz+ritmo — então a precisão da tarifa é imaterial aqui.
-- Ajustar quando a tarifa oficial por caractere estiver catalogada.
--
-- ESCOPO: puramente aditivo (uma linha de catálogo). Não altera preços
-- existentes, não remove/atualiza dados. Idempotente via WHERE NOT EXISTS.
-- =============================================================================

INSERT INTO public.provider_pricing
  (provider, service, model, region, metric_key, currency, unit_size, price_per_unit, valid_from, valid_until, is_active, source_reference, metadata)
SELECT
  'openai', 'audio.speech', 'gpt-4o-mini-tts', NULL, 'tts_characters', 'USD',
  1000000, 15.00, '2026-08-12 00:00:00+00', NULL, true,
  'Espelho conservador do preço do tts-1 (US$15/1M chars) enquanto a tarifa por caractere do gpt-4o-mini-tts não é catalogada. gpt-4o-mini-tts é mais barato, então nunca subestima o orçamento. Volume mínimo (amostras cacheadas).',
  jsonb_build_object('conservative_mirror_of', 'tts-1', 'reason', 'preview_tts_model_change_to_gpt-4o-mini-tts')
WHERE NOT EXISTS (
  SELECT 1 FROM public.provider_pricing
  WHERE provider = 'openai' AND service = 'audio.speech' AND model = 'gpt-4o-mini-tts'
    AND metric_key = 'tts_characters' AND currency = 'USD' AND valid_until IS NULL
);

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
