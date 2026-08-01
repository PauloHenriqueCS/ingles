-- =============================================================================
-- MIGRATION: 20260723040002_create_user_communication_blocks
-- Projeto: Lemon (english learning app)
--
-- Etapa: exclusao logica de conta -- supressao de comunicacao.
-- Tabela reutilizavel para qualquer motivo de supressao de comunicacao, nao
-- apenas exclusao de conta (LGPD, retirada de consentimento, descadastro de
-- marketing, solicitacao administrativa, bloqueio de seguranca, reclamacao).
-- Deliberadamente separada de public.user_billing_blocks.
--
-- user_id e opcional (NULL permitido, sem ON DELETE CASCADE) de proposito:
-- esta tabela precisa continuar suprimindo envios mesmo se os dados
-- principais do usuario forem futuramente apagados/anonimizados por uma
-- solicitacao de LGPD -- destination_hash (HMAC determinístico, calculado no
-- backend com COMMUNICATION_SUPPRESSION_HMAC_SECRET) e o identificador que
-- sobrevive a esse cenario. Nunca armazenar e-mail/telefone em texto puro
-- aqui.
--
-- Auditoria de provedores de comunicacao existentes neste repositorio (feita
-- antes desta migration, ver relatorio final da tarefa): NENHUM provedor de
-- e-mail/SMS/push/WhatsApp (Resend, SendGrid, Mailchimp, Brevo, OneSignal,
-- Firebase Cloud Messaging, Twilio) esta integrado neste codigo-fonte hoje.
-- Esta tabela e o helper central (api/_account/communication-suppression.ts,
-- canSendCommunication) sao criados do mesmo jeito, prontos para quando um
-- provedor real for adicionado.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_communication_blocks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  channel           text NOT NULL,
  scope             text NOT NULL DEFAULT 'all',
  reason            text NOT NULL,
  source            text NOT NULL,
  destination_hash  text NULL,
  is_active         boolean NOT NULL DEFAULT true,
  blocked_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NULL,
  lifted_at         timestamptz NULL,
  lifted_by         uuid NULL REFERENCES auth.users(id),
  lift_reason       text NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ucb_channel CHECK (channel IN ('email', 'sms', 'push', 'whatsapp', 'in_app')),
  CONSTRAINT chk_ucb_scope CHECK (scope IN ('marketing', 'transactional', 'all')),
  CONSTRAINT chk_ucb_has_identifier CHECK (user_id IS NOT NULL OR destination_hash IS NOT NULL),
  CONSTRAINT chk_ucb_lift_fields CHECK (
    (is_active = true AND lifted_at IS NULL)
    OR
    (is_active = false)
  )
);

COMMENT ON TABLE public.user_communication_blocks IS
  'Supressao central de comunicacao (e-mail/sms/push/whatsapp/in_app), reutilizavel para exclusao de conta, LGPD, retirada de consentimento e descadastro. destination_hash e um HMAC-SHA256 determinístico do destino normalizado (nunca texto puro), calculado com o segredo COMMUNICATION_SUPPRESSION_HMAC_SECRET (apenas backend). Nunca usar ON DELETE CASCADE no FK de user_id.';

-- No maximo um bloqueio ATIVO por usuario+canal+escopo+motivo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_communication_blocks_active_user
  ON public.user_communication_blocks (user_id, channel, scope, reason)
  WHERE is_active = true AND user_id IS NOT NULL;

-- Mesma unicidade pelo hash do destino, para o caso (futuro/LGPD) em que
-- user_id seja NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_communication_blocks_active_hash
  ON public.user_communication_blocks (destination_hash, channel, scope, reason)
  WHERE is_active = true AND destination_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_communication_blocks_user_id
  ON public.user_communication_blocks (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_communication_blocks_destination_hash
  ON public.user_communication_blocks (destination_hash)
  WHERE destination_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_communication_blocks_channel_active
  ON public.user_communication_blocks (channel, is_active);

DROP TRIGGER IF EXISTS trg_user_communication_blocks_updated_at ON public.user_communication_blocks;
CREATE TRIGGER trg_user_communication_blocks_updated_at
  BEFORE UPDATE ON public.user_communication_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: mesmo padrao de public.user_conversation_credits.
ALTER TABLE public.user_communication_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_communication_blocks_read ON public.user_communication_blocks;
CREATE POLICY user_communication_blocks_read
  ON public.user_communication_blocks
  FOR SELECT
  TO public
  USING (is_active_admin());

DROP POLICY IF EXISTS user_communication_blocks_write ON public.user_communication_blocks;
CREATE POLICY user_communication_blocks_write
  ON public.user_communication_blocks
  FOR INSERT
  TO public
  WITH CHECK (can_manage_plans());

DROP POLICY IF EXISTS user_communication_blocks_update ON public.user_communication_blocks;
CREATE POLICY user_communication_blocks_update
  ON public.user_communication_blocks
  FOR UPDATE
  TO public
  USING (can_manage_plans());

REVOKE ALL ON public.user_communication_blocks FROM anon;

-- =============================================================================
-- VALIDACAO INLINE
-- =============================================================================

DO $$
DECLARE
  v_anon BOOLEAN;
BEGIN
  v_anon := has_table_privilege('anon', 'public.user_communication_blocks', 'SELECT,INSERT,UPDATE,DELETE');
  IF v_anon THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds a privilege on user_communication_blocks';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'user_communication_blocks' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on user_communication_blocks';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: user_communication_blocks created with RLS, anon stripped, per-channel active-block indexes in place';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723040002_create_user_communication_blocks
-- =============================================================================
