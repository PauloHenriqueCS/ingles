-- =============================================================================
-- MIGRATION: 20260826180000_conversation_session_mode_preference
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   Persistir a preferência de MODO da conversa (guided/free) do usuário, ao
--   lado da preferência de idioma (ai_conversation_preferences.
--   conversation_language_mode, já existente). Assim a nova etapa "Antes de
--   começar" e a tela Personalizar tutor guardam AMBAS as escolhas como
--   preferências do usuário, e a tela inicial mostra o resumo salvo.
--
--   Esta é apenas a PREFERÊNCIA (última escolha). O MODO efetivo de cada sessão
--   continua CONGELADO por sessão em conversation_session_authorizations.
--   session_mode (inalterado), e a resolução server-side (resolveSessionMode +
--   computeGuidedEligible) segue sendo a autoridade de crédito curricular.
--
-- COMPATIBILIDADE: aditivo, idempotente, anulável. NULL = sem preferência salva
-- (a UI recorre ao padrão do produto: guided). Não afeta minutos/crédito/histórico.
-- =============================================================================

ALTER TABLE public.ai_conversation_preferences
  ADD COLUMN IF NOT EXISTS conversation_session_mode text
    CHECK (
      conversation_session_mode IS NULL
      OR conversation_session_mode IN ('guided', 'free')
    );

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
