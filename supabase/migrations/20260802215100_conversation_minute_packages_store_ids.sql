-- =============================================================================
-- MIGRATION: 20260802215100_conversation_minute_packages_store_ids
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- Etapa: completa public.conversation_minute_packages (criada em
-- 20260727230000_conversation_minute_packages_catalog.sql) com as duas
-- colunas de identificador de produto das lojas, ainda ausentes. Aditiva
-- apenas — nenhuma coluna existente é removida, renomeada ou tem seu tipo
-- alterado; preço, minutos e compatible_plan_codes não são tocados; nenhuma
-- tabela paralela é criada.
--
-- Os três pacotes hoje cadastrados (pacote-300-min, pacote-600-min,
-- pacote-900-min) estão status='published'/active=true sem nenhum dos dois
-- IDs de loja configurados — ou seja, hoje aparecem como elegíveis
-- (conversation_minute_packages_catalog.sql: active=true AND
-- status='published' determina elegibilidade) sem estarem de fato
-- configurados para venda em nenhuma loja. Esta migration corrige esse
-- estado: enquanto apple_product_id e google_product_id estiverem ausentes,
-- os três voltam para status='draft'/active=false. Os registros continuam
-- no banco (nenhum DELETE) — apenas deixam de ser elegíveis até o dashboard
-- preencher os IDs reais e republicar. O guard
-- `apple_product_id IS NULL AND google_product_id IS NULL` torna o UPDATE
-- idempotente e seguro para reexecução: uma vez que os IDs reais existam,
-- rodar esta migration de novo (ou uma cópia dela) não vai reverter um
-- pacote já publicado corretamente de volta para draft.
--
-- Fora de escopo, de propósito: checkout, StoreKit, Google Play Billing,
-- trial (continua sem acesso a pacotes extras), e qualquer publicação nova
-- destes pacotes — isso é trabalho do dashboard administrativo, uma vez que
-- os IDs reais das lojas existam.
-- =============================================================================

ALTER TABLE public.conversation_minute_packages
  ADD COLUMN IF NOT EXISTS apple_product_id text,
  ADD COLUMN IF NOT EXISTS google_product_id text;

UPDATE public.conversation_minute_packages
SET status = 'draft',
    active = false
WHERE code IN ('pacote-300-min', 'pacote-600-min', 'pacote-900-min')
  AND apple_product_id IS NULL
  AND google_product_id IS NULL;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado,
-- e confirme os três pacotes:
--   SELECT code, status, active, apple_product_id, google_product_id
--   FROM public.conversation_minute_packages
--   WHERE code IN ('pacote-300-min', 'pacote-600-min', 'pacote-900-min');
-- deve retornar as três linhas com status='draft', active=false, e ambos os
-- IDs NULL.
