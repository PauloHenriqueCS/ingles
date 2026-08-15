-- =============================================================================
-- MIGRATION: 20260815121800_writing_theme_link_and_convergent_credit
-- Projeto: Orodim
--
-- Aplicada automaticamente por deploy-production.yml / homologation.yml
-- (supabase db push). Não aplicar manualmente no SQL Editor.
--
-- OBJETIVO:
--   (blocker 2) Ligar a revisão de escrita à MISSÃO EXATA que a gerou:
--   english_reviews.generated_theme_id (FK lógica para generated_themes). O
--   review credita o recorte da missão, nunca "o último tema".
--   (blocker 6) Convergência de crédito curricular: um retry de uma atividade já
--   concluída comercialmente deve conseguir reconciliar o crédito curricular
--   idempotentemente. curriculum_credit_status = 'pending' | 'credited' registra
--   o progresso, MAS a fonte de verdade continua sendo
--   user_subtopic_modality_progress (a coluna é só um marcador auxiliar).
--
-- COMPATIBILIDADE: aditivo, idempotente. Preserva dados/RLS/grants.
-- =============================================================================

ALTER TABLE public.english_reviews
  ADD COLUMN IF NOT EXISTS generated_theme_id uuid,
  ADD COLUMN IF NOT EXISTS curriculum_credit_status text
    CHECK (curriculum_credit_status IS NULL OR curriculum_credit_status IN ('pending', 'credited'));

ALTER TABLE public.pronunciation_training_sessions
  ADD COLUMN IF NOT EXISTS curriculum_credit_status text
    CHECK (curriculum_credit_status IS NULL OR curriculum_credit_status IN ('pending', 'credited'));

ALTER TABLE public.conversation_session_authorizations
  ADD COLUMN IF NOT EXISTS curriculum_credit_status text
    CHECK (curriculum_credit_status IS NULL OR curriculum_credit_status IN ('pending', 'credited'));

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado.
