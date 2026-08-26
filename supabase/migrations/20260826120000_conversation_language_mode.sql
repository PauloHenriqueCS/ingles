-- =============================================================================
-- MIGRATION: 20260826120000_conversation_language_mode
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Adicionar a escolha de IDIOMA da sessão de Conversa (english_only vs
--   bilingual_pt_en), orientada a dados e retrocompatível.
--
--   1. conversation_session_authorizations.conversation_language_mode —
--      CONGELA o modo de idioma no INÍCIO da sessão, exatamente como
--      session_mode (guided/free). A sessão viva usa esse valor durante toda a
--      sua duração; sessões antigas sem o campo (NULL) equivalem ao
--      comportamento histórico english_only (fallback aplicado no servidor).
--
--   2. ai_conversation_preferences.conversation_language_mode — guarda a ÚLTIMA
--      escolha do usuário para pré-selecioná-la na próxima Conversa. NULL =
--      nenhuma escolha anterior; a UI recorre à recomendação por nível.
--
-- NÃO afeta contabilização de minutos, crédito curricular, retomada nem
-- histórico: o campo é puramente de comportamento/instrução da IA + auditoria.
--
-- COMPATIBILIDADE: aditivo, idempotente. Preserva dados/RLS/grants.
-- =============================================================================

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS conversation_language_mode text
    CHECK (
      conversation_language_mode IS NULL
      OR conversation_language_mode IN ('english_only', 'bilingual_pt_en')
    );

ALTER TABLE public.ai_conversation_preferences
  ADD COLUMN IF NOT EXISTS conversation_language_mode text
    CHECK (
      conversation_language_mode IS NULL
      OR conversation_language_mode IN ('english_only', 'bilingual_pt_en')
    );

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
