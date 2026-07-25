-- =============================================================================
-- MIGRATION: 20260723040000_create_user_account_deactivations
-- Projeto: Lemon (english learning app)
--
-- Etapa: exclusao logica de conta (self-service "Excluir minha conta").
-- Fonte de verdade unica de "esta conta esta desativada por pedido do
-- proprio usuario" -- deliberadamente separada de public.user_access_controls
-- (mecanismo existente de suspensao ADMINISTRATIVA, lido dentro de
-- admin_resolve_effective_plan_v1). Decisao documentada: nao reutilizamos
-- user_access_controls.is_suspended para a exclusao logica porque:
--   1. Misturaria dois motivos de bloqueio de acesso sob a mesma coluna --
--      uma reativacao administrativa de uma suspensao por abuso (fluxo ja
--      existente, fora deste repositorio) poderia acidentalmente reverter
--      uma exclusao de conta solicitada pelo proprio usuario, violando o
--      requisito de que cada bloqueio mantenha seu motivo/origem e de que a
--      reativacao apos exclusao seja sempre uma operacao explicita e distinta.
--   2. O bloqueio de acesso desta funcionalidade e aplicado inteiramente no
--      backend (requireAuth em api/_auth.ts, ver isAccountDeactivated em
--      api/_account/deactivation-status.ts) e na propria camada do Supabase
--      Auth (ban_duration + signOut global via auth.admin, aplicados pelo
--      servico de desativacao) -- nao depende de admin_resolve_effective_plan_v1
--      nem de RLS row-level para funcionar.
-- Nenhum dado do usuario e apagado por esta migration ou pelo fluxo que a usa.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_account_deactivations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id),
  status              text NOT NULL DEFAULT 'deactivated',
  reason              text NOT NULL DEFAULT 'user_requested_account_deletion',
  requested_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at      timestamptz NOT NULL DEFAULT now(),
  reactivated_at      timestamptz NULL,
  reactivated_by      uuid NULL REFERENCES auth.users(id),
  reactivation_reason text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_uad_status CHECK (status IN ('deactivated', 'reactivated')),
  CONSTRAINT chk_uad_reactivation_fields CHECK (
    (status = 'deactivated' AND reactivated_at IS NULL AND reactivated_by IS NULL)
    OR
    (status = 'reactivated' AND reactivated_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.user_account_deactivations IS
  'Fonte de verdade da exclusao logica de conta (self-service). Nunca apaga dados do usuario, nunca remove o usuario do Supabase Auth. Reativacao e sempre uma acao administrativa explicita e auditada, separada por design de public.user_access_controls (suspensao administrativa).';

-- No maximo uma desativacao ATIVA por usuario -- torna o insert idempotente
-- quando combinado com "select existente antes de inserir" no backend, e
-- funciona como guarda de ultima linha contra corrida entre duas chamadas
-- concorrentes ao endpoint de exclusao.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_deactivations_active
  ON public.user_account_deactivations (user_id)
  WHERE status = 'deactivated';

CREATE INDEX IF NOT EXISTS idx_user_account_deactivations_user_id
  ON public.user_account_deactivations (user_id);

DROP TRIGGER IF EXISTS trg_user_account_deactivations_updated_at ON public.user_account_deactivations;
CREATE TRIGGER trg_user_account_deactivations_updated_at
  BEFORE UPDATE ON public.user_account_deactivations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: mesmo padrao ja usado em public.user_conversation_credits
-- (is_active_admin() para leitura administrativa, can_manage_plans() para
-- escrita administrativa). O usuario comum nunca le nem grava aqui via
-- PostgREST -- toda leitura/escrita do fluxo de exclusao acontece no backend
-- com o service_role client (ver api/_account/deactivation-repository.ts),
-- que contorna RLS por padrao no Supabase.
ALTER TABLE public.user_account_deactivations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_account_deactivations_read ON public.user_account_deactivations;
CREATE POLICY user_account_deactivations_read
  ON public.user_account_deactivations
  FOR SELECT
  TO public
  USING (is_active_admin());

DROP POLICY IF EXISTS user_account_deactivations_write ON public.user_account_deactivations;
CREATE POLICY user_account_deactivations_write
  ON public.user_account_deactivations
  FOR INSERT
  TO public
  WITH CHECK (can_manage_plans());

DROP POLICY IF EXISTS user_account_deactivations_update ON public.user_account_deactivations;
CREATE POLICY user_account_deactivations_update
  ON public.user_account_deactivations
  FOR UPDATE
  TO public
  USING (can_manage_plans());

-- Defesa em profundidade: revoga explicitamente o grant padrao do Supabase
-- para anon nesta tabela nova (authenticated mantem o grant padrao, que e
-- necessario para admins autenticados usarem as policies acima).
REVOKE ALL ON public.user_account_deactivations FROM anon;

-- =============================================================================
-- VALIDACAO INLINE
-- =============================================================================

DO $$
DECLARE
  v_anon BOOLEAN;
BEGIN
  v_anon := has_table_privilege('anon', 'public.user_account_deactivations', 'SELECT,INSERT,UPDATE,DELETE');
  IF v_anon THEN
    RAISE EXCEPTION 'VALIDATION FAILED: anon still holds a privilege on user_account_deactivations';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'user_account_deactivations' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'VALIDATION FAILED: RLS is not enabled on user_account_deactivations';
  END IF;

  RAISE NOTICE 'VALIDATION PASSED: user_account_deactivations created with RLS, anon stripped, single-active-row index in place';
END $$;

COMMIT;

-- =============================================================================
-- FIM DA MIGRATION 20260723040000_create_user_account_deactivations
-- =============================================================================
