-- =============================================================================
-- MIGRATION: 20260723040001_create_user_billing_blocks
-- Projeto: Lemon (english learning app)
--
-- Etapa: exclusao logica de conta -- bloqueio de cobranca.
-- Tabela exclusiva para impedir novas cobrancas/assinaturas/renovacoes.
-- Deliberadamente separada de public.user_communication_blocks (motivos e
-- ciclos de vida diferentes -- ver migration seguinte).
--
-- Auditoria do provedor de pagamento existente neste repositorio (feita
-- antes desta migration, ver relatorio final da tarefa): NENHUM provedor de
-- pagamento externo (Stripe, Apple App Store, Google Play, RevenueCat,
-- Mercado Pago) esta integrado neste codigo-fonte. Planos sao atribuidos
-- internamente via public.user_plan_assignments (gerenciado por um painel
-- administrativo fora deste repositorio). Esta tabela e criada do mesmo jeito
-- porque e um requisito explicito da tarefa e fica pronta para o dia em que
-- um checkout/assinatura real for implementado -- ver
-- api/_account/billing-block-repository.ts (assertBillingAllowed) para o
-- helper central que qualquer fluxo de cobranca futuro devera consultar.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_billing_blocks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES auth.users(id),
  reason                 text NOT NULL,
  source                 text NOT NULL,
  is_active              boolean NOT NULL DEFAULT true,
  blocked_at             timestamptz NOT NULL DEFAULT now(),
  external_customer_id   text NULL,
  external_subscription_id text NULL,
  provider               text NULL,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  lifted_at              timestamptz NULL,
  lifted_by              uuid NULL REFERENCES auth.users(id),
  lift_reason            text NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ubb_lift_fields CHECK (
    (is_active = true AND lifted_at IS NULL)
    OR
    (is_active = false)
  )
);

COMMENT ON TABLE public.user_billing_blocks IS
  'Bloqueio central de cobranca/assinatura por usuario. Toda rotina de checkout, criacao/renovacao de assinatura e processamento de webhook de pagamento deve consultar is_active=true aqui antes de agir (codigo de erro: BILLING_BLOCKED_ACCOUNT_DEACTIVATED). Nunca usar ON DELETE CASCADE no FK de user_id -- o registro deve sobreviver a qualquer alteracao administrativa do perfil.';

-- No maximo um bloqueio ATIVO por usuario+motivo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_billing_blocks_active_reason
  ON public.user_billing_blocks (user_id, reason)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_user_billing_blocks_user_id
  ON public.user_billing_blocks (user_id);

CREATE INDEX IF NOT EXISTS idx_user_billing_blocks_active
  ON public.user_billing_blocks (user_id)
  WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_user_billing_blocks_updated_at ON public.user_billing_blocks;
CREATE TRIGGER trg_user_billing_blocks_updated_at
  BEFORE UPDATE ON public.user_billing_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: mesmo padrao de public.user_conversation_credits.
ALTER TABLE public.user_billing_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_billing_blocks_read ON public.user_billing_blocks;
CREATE POLICY user_billing_blocks_read
  ON public.user_billing_blocks
  FOR SELECT
  TO public
  USING (is_active_admin());

DROP POLICY IF EXISTS user_billing_blocks_write ON public.user_billing_blocks;
CREATE POLICY user_billing_blocks_write
  ON public.user_billing_blocks
  FOR INSERT
  TO public
  WITH CHECK (can_manage_plans());

DROP POLICY IF EXISTS user_billing_blocks_update ON public.user_billing_blocks;
CREATE POLICY user_billing_blocks_update
  ON public.user_billing_blocks
  FOR UPDATE
  TO public
  USING (can_manage_plans());

REVOKE ALL ON public.user_billing_blocks FROM anon;

-- =============================================================================
-- VALIDACAO INLINE
-- =============================================================================

DO $$
DECLARE
  v_anon BOOLEAN;
BEGIN
  v_anon := has_table_privilege('anon', 'public.user_billing_blocks', 'SELECT,INSERT,UPDATE,DELETE');
  IF v_anon THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds a privilege on user_billing_blocks';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'user_billing_blocks' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on user_billing_blocks';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: user_billing_blocks created with RLS, anon stripped, single-active-block-per-reason index in place';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723040001_create_user_billing_blocks
-- =============================================================================
