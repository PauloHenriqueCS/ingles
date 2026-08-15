-- =============================================================================
-- MIGRATION: 20260815121500_conversation_mode_and_theme_identity
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   (blocker 3) Congelar no INÍCIO da sessão de conversa se ela é elegível como
--   prática curricular: conversation_session_authorizations.session_mode +
--   curriculum_practice_eligible. A conclusão lê esses campos e NUNCA reconsulta
--   a preferência atual — ligar/desligar a modalidade no meio nunca muda se a
--   sessão conta.
--   (blocker 7) Identidade curricular na MISSÃO de escrita gerada
--   (generated_themes.curriculum_version_id + curriculum_subtopic_key), lida no
--   review para creditar Writing no recorte de ORIGEM da missão.
--
-- COMPATIBILIDADE: aditivo, idempotente. Preserva dados/RLS/grants.
-- =============================================================================

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS session_mode text
    CHECK (session_mode IS NULL OR session_mode IN ('free', 'guided')),
  ADD COLUMN IF NOT EXISTS curriculum_practice_eligible boolean NOT NULL DEFAULT false;

ALTER TABLE public.generated_themes
  ADD COLUMN IF NOT EXISTS curriculum_version_id uuid,
  ADD COLUMN IF NOT EXISTS curriculum_subtopic_key text;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
