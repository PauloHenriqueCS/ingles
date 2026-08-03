-- =============================================================================
-- MIGRATION: 20260803233000_revenuecat_webhook_events
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- Etapa: infraestrutura de idempotência para o webhook do RevenueCat
-- (integração Apple/iOS — ver api/_billing/). Duas peças, ambas aditivas:
--
-- 1) public.revenuecat_webhook_events — registro de cada entrega de webhook
--    já processada, pela chave natural do RevenueCat (revenuecat_event_id),
--    para que um evento reentregue (RevenueCat reenviar em retry, ou uma
--    reconciliação manual) nunca aplique o mesmo efeito duas vezes. Nunca
--    grava o payload bruto completo — apenas payload_hash (SHA-256) para
--    detecção de divergência, nunca dados de pagamento. Somente
--    backend/service_role acessa esta tabela: RLS habilitada, ZERO policies
--    (nenhuma linha visível a `authenticated`/`anon` mesmo que algum dia
--    ganhem GRANT por engano) e GRANT explícito restrito a service_role —
--    aprendendo com a causa raiz já documentada em
--    20260802221500_conversation_minute_packages_grants.sql: uma tabela
--    nova NUNCA herda privilégio nenhum automaticamente neste banco (
--    pg_default_acl confirmado vazio para o schema public), então toda
--    tabela nova precisa de GRANT explícito para o papel que vai
--    efetivamente usá-la — aqui, só service_role, nunca authenticated/anon.
--
-- 2) Um índice único parcial em public.user_conversation_credits
--    (source, external_reference) — a mesma proteção de idempotência para o
--    crédito de pacotes de minutos consumíveis (transaction_id do
--    RevenueCat vira external_reference; ver
--    api/_billing/revenuecat-minute-credit-service.ts). A tabela já existe
--    (20260725120000_baseline_full_database.sql) e já tem GRANT completo
--    para service_role — nenhuma alteração de GRANT necessária aqui, só o
--    índice. external_reference já era nullable e sem uso em código antes
--    desta tarefa (só leitura de remaining_seconds existia); esta é a
--    primeira migration a de fato escrever nesta tabela.
--
-- Fora de escopo, de propósito: nenhuma mudança em preços, limites,
-- plan_capability_values, planos comerciais, franquia do trial, ou qualquer
-- tabela do dashboard administrativo. Nenhum dado é apagado ou reescrito.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.revenuecat_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revenuecat_event_id text NOT NULL,
  event_type text NOT NULL,
  -- Valor exatamente como o RevenueCat envia (ex.: 'SANDBOX'/'PRODUCTION') —
  -- sem CHECK de valores aqui de propósito: a distinção sandbox/production
  -- que realmente importa ("evento sandbox nunca pode alterar produção") é
  -- feita em código (comparação case-insensitive), nunca por uma constraint
  -- de banco que poderia rejeitar uma entrega legítima por causa de
  -- variação de caixa não prevista aqui.
  environment text NOT NULL,
  app_user_id text,
  product_id text,
  transaction_id text,
  original_transaction_id text,
  payload_hash text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received',
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  processed_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT revenuecat_webhook_events_event_id_key UNIQUE (revenuecat_event_id),
  CONSTRAINT revenuecat_webhook_events_processing_status_check
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed'))
);

COMMENT ON TABLE public.revenuecat_webhook_events IS
  'Log idempotente de eventos de webhook do RevenueCat (integração Apple/iOS) — chave natural revenuecat_event_id. Nunca guarda payload bruto completo, só payload_hash. Somente backend/service_role; RLS habilitada sem policies.';

CREATE INDEX IF NOT EXISTS idx_revenuecat_webhook_events_app_user_id
  ON public.revenuecat_webhook_events (app_user_id);
CREATE INDEX IF NOT EXISTS idx_revenuecat_webhook_events_received_at
  ON public.revenuecat_webhook_events (received_at);

DROP TRIGGER IF EXISTS trg_revenuecat_webhook_events_updated_at ON public.revenuecat_webhook_events;
CREATE TRIGGER trg_revenuecat_webhook_events_updated_at
  BEFORE UPDATE ON public.revenuecat_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.revenuecat_webhook_events ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy criada — zero linhas visíveis a qualquer papel além do
-- owner, independentemente de GRANT. Acesso real é só via service_role
-- (que ignora RLS por BYPASSRLS), nunca via PostgREST direto.

REVOKE ALL ON public.revenuecat_webhook_events FROM PUBLIC;
REVOKE ALL ON public.revenuecat_webhook_events FROM anon;
REVOKE ALL ON public.revenuecat_webhook_events FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.revenuecat_webhook_events TO service_role;

-- ── Idempotência do crédito de pacotes de minutos consumíveis ──────────────
-- (source, external_reference) já cobre 'purchase' (RevenueCat) sem colidir
-- com outras origens (admin_grant/promotion/refund) que também podem usar
-- external_reference com seu próprio significado.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_conversation_credits_external_reference
  ON public.user_conversation_credits (source, external_reference)
  WHERE external_reference IS NOT NULL;

-- Após aplicar: execute supabase/verify_schema.sql, e confirme:
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND table_name='revenuecat_webhook_events'
--   ORDER BY grantee, privilege_type;
-- deve retornar apenas postgres (owner) e service_role (SELECT, INSERT,
-- UPDATE) — nenhuma linha para anon/authenticated/PUBLIC.
