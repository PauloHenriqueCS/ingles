-- =============================================================================
-- MIGRATION: 20260831120000_user_study_routine_config
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop, e por deploy-production.yml em main.
-- NÃO aplicar manualmente no SQL Editor nem via MCP apply_migration — isso
-- desalinha o histórico de `supabase migration list` / schema_migrations.
--
-- OBJETIVO: persistir, POR USUÁRIO e no servidor (nunca localStorage como fonte
-- da verdade), a CONCLUSÃO do onboarding de "Rotina de estudos" — a etapa
-- OBRIGATÓRIA de primeiro acesso que aparece DEPOIS do tutorial interativo da
-- Home e antes de liberar a Home normalmente. Nessa etapa o usuário escolhe:
--   1) os DIAS DE PRÁTICA  → persistidos em user_learning_settings.active_weekdays
--   2) as PRÁTICAS do plano → persistidas em user_curriculum_preferences.practice_*
-- Esta tabela NÃO duplica esses dados: ela guarda apenas o FLAG de "já concluiu a
-- configuração inicial", para que o gate obrigatório saiba quando parar de exigir.
-- Os valores continuam com as tabelas existentes (fonte única da verdade).
--
-- SEMÂNTICA DO STATUS (duas situações claras):
--   * unconfigured → nunca concluiu a configuração inicial → o gate deve exigi-la.
--                    Para um usuário NOVO isso é representado pela AUSÊNCIA de
--                    linha (o cliente trata "sem linha" como unconfigured). Ao
--                    concluir, grava-se a linha com status='configured'.
--   * configured   → concluiu a etapa obrigatória. Grava configured_at.
--
-- ROLLOUT SEGURO — usuários ANTIGOS não podem ser forçados a refazer o que já
-- possuem: quem já usa o app JÁ tem dias e práticas (defaults ou escolhas
-- próprias) e não deve ver o modal obrigatório. Todos os usuários existentes no
-- momento do deploy são "grandfathered": inserimos para eles uma linha
-- status='configured' (configured_at=now()). Somente contas criadas APÓS este
-- backfill não terão linha → o cliente as trata como unconfigured → veem a
-- configuração obrigatória. Eles ainda podem editar tudo depois no menu →
-- "Rotina de estudos" (sem alterar este flag). ON CONFLICT DO NOTHING torna o
-- backfill idempotente — nunca sobrescreve um status já gravado.
--
-- ESCOPO: puramente aditivo — uma tabela nova + RLS + grants + trigger de
-- updated_at (função public.set_updated_at já existe no baseline) + backfill
-- idempotente. Nada aqui toca em planos, assinatura, currículo, streak, quotas,
-- placement, tutorial, RevenueCat, push ou qualquer outra feature.
-- =============================================================================

-- ── Tabela: uma linha por usuário (user_id é a PK → unicidade natural) ───────
CREATE TABLE IF NOT EXISTS public.user_study_routine_config (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Estado persistido. 'unconfigured' é o DEFAULT do banco, mas na prática a
  -- ausência de linha já representa "unconfigured" no cliente; o valor só é
  -- gravado como 'configured' quando o usuário conclui a etapa obrigatória.
  status        text NOT NULL DEFAULT 'unconfigured',
  configured_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usrc_status_domain CHECK (status IN ('unconfigured', 'configured'))
);

COMMENT ON TABLE public.user_study_routine_config IS
  'Flag de conclusão do onboarding obrigatório de "Rotina de estudos" (dias de prática + práticas do plano), exibido depois do tutorial no primeiro acesso. status ∈ {unconfigured,configured}; ausência de linha = unconfigured (usuário novo). configured_at registra o momento. Uma linha por user_id (PK). NÃO duplica os dados — estes permanecem em user_learning_settings.active_weekdays e user_curriculum_preferences.practice_*. Backfill de rollout marca usuários pré-existentes como configured para não forçá-los ao modal.';

-- Mantém updated_at coerente em qualquer UPDATE (função do baseline).
DROP TRIGGER IF EXISTS trg_user_study_routine_config_updated_at
  ON public.user_study_routine_config;
CREATE TRIGGER trg_user_study_routine_config_updated_at
  BEFORE UPDATE ON public.user_study_routine_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- O cliente lê e escreve DIRETAMENTE a própria linha (é um estado do usuário,
-- sem gating server-side). RLS garante que cada um só enxerga/altera a própria
-- linha (auth.uid() = user_id). Tabela nova não herda privilégio algum neste
-- banco, então todo GRANT é explícito.
ALTER TABLE public.user_study_routine_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usrc_all_own ON public.user_study_routine_config;
CREATE POLICY usrc_all_own ON public.user_study_routine_config
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.user_study_routine_config FROM PUBLIC;
REVOKE ALL ON public.user_study_routine_config FROM anon;
REVOKE ALL ON public.user_study_routine_config FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_study_routine_config TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_study_routine_config TO service_role;

-- ── Backfill de rollout (idempotente) ────────────────────────────────────────
-- Marca TODOS os usuários que já existem no momento do deploy como 'configured'
-- (grandfathered), para que o modal obrigatório de configuração NUNCA dispare
-- para quem já usa o app (eles já têm dias e práticas). Contas criadas depois
-- deste ponto não terão linha e serão tratadas como 'unconfigured' pelo cliente
-- → veem a configuração obrigatória. ON CONFLICT DO NOTHING torna o backfill
-- seguro para reexecução (nunca sobrescreve um status já gravado por um usuário).
INSERT INTO public.user_study_routine_config (user_id, status, configured_at)
SELECT u.id, 'configured', now()
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;
