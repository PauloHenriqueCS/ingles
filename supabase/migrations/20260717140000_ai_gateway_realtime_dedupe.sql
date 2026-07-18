-- =============================================================================
-- MIGRATION: 20260717140000_ai_gateway_realtime_dedupe
-- Projeto: Lemon (english learning app)
--
-- Etapa 10 do AI Gateway: suporte de idempotência para eventos de uso do
-- Realtime relayados pelo browser (conversation.realtime_usage). Sem isso,
-- uma retransmissão duplicada do mesmo evento response.done (retry de rede,
-- StrictMode, corrida de reconexão) poderia gravar tokens duas vezes.
--
-- Esta migration é EXCLUSIVAMENTE aditiva:
--   • Nenhuma coluna, tabela ou índice existente é removido ou renomeado.
--   • Nenhum dado existente é alterado ou apagado.
--   • Nenhum evento em ai_usage_events é tocado.
--   • Idempotente: CREATE UNIQUE INDEX IF NOT EXISTS.
--
-- Auditoria do schema (Fase 6) — nenhuma coluna nova foi necessária:
--   ai_usage_events já tem provider_request_id TEXT (BLOCO 5 da migration
--   20260717000000) e provider_session_record_id UUID (mesma migration).
--   idempotency_key existe mas é deliberadamente NÃO único (retries
--   legítimos de outras features compartilham a mesma chave — ver comentário
--   original da fundação). Reaproveitar essa coluna para dedupe teria
--   enfraquecido essa garantia para todas as outras features. Em vez disso,
--   este dedupe usa (provider_session_record_id, provider_request_id): o
--   browser relaya o campo oficial `response.id` do evento response.done da
--   OpenAI Realtime API como provider_request_id, e o par com a sessão já
--   identifica de forma única "este response.done desta sessão".
--
--   Correção via constraint única (não "consultar e depois inserir"): um
--   INSERT que colida com este índice falha atomicamente com SQLSTATE 23505
--   (unique_violation); api/_ai-gateway/usage-repository.ts traduz isso para
--   DuplicateUsageEventError, tratado pelo chamador como no-op idempotente —
--   nunca há uma janela de corrida entre "verificar" e "inserir".
--
-- Escopo: o índice é parcial (WHERE ambas as colunas não são NULL), então
-- não afeta nenhuma feature existente, cujos eventos nunca preenchem
-- provider_session_record_id + provider_request_id ao mesmo tempo hoje.
-- =============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_aue_session_provider_request
  ON public.ai_usage_events (provider_session_record_id, provider_request_id)
  WHERE provider_session_record_id IS NOT NULL AND provider_request_id IS NOT NULL;

-- =============================================================================
-- VALIDAÇÃO INLINE
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'ai_usage_events'
      AND indexname  = 'uq_aue_session_provider_request'
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: uq_aue_session_provider_request index was not created';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260717140000_ai_gateway_realtime_dedupe
-- =============================================================================
