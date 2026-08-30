-- =============================================================================
-- MIGRATION: 20260830120000_user_tutorial_progress
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop, e por deploy-production.yml em main.
-- NÃO aplicar manualmente no SQL Editor nem via MCP apply_migration — isso
-- desalinha o histórico de `supabase migration list` / schema_migrations.
--
-- OBJETIVO: persistir, POR USUÁRIO e no servidor (nunca localStorage como fonte
-- da verdade), o status do TUTORIAL INTERATIVO DE PRIMEIRO ACESSO da Home (o
-- walkthrough guiado que aparece DEPOIS do teste de nível / PlacementOnboarding,
-- na primeira vez que o usuário chega à Home real).
--
-- SEMÂNTICA DO STATUS (três situações claras, §8 da spec):
--   * pending    → nunca concluiu nem pulou o tutorial → deve vê-lo. Para um
--                  usuário NOVO isso é representado pela AUSÊNCIA de linha (o
--                  cliente trata "sem linha" como pending); ao concluir/pular,
--                  grava-se a linha com o status terminal.
--   * completed  → concluiu a última etapa. Grava completed_at.
--   * skipped    → tocou em "Pular tutorial" em qualquer etapa. Grava skipped_at.
--
-- ROLLOUT SEGURO (§8) — usuários ANTIGOS não podem ser forçados a assistir:
--   Este tutorial é de PRIMEIRO ACESSO. Todos os usuários que já existem no
--   momento do deploy são "grandfathered": inserimos para eles uma linha
--   status='completed' (completed_at=now()) para que a Home NUNCA dispare o
--   tutorial automaticamente para quem já usa o app. Somente contas criadas
--   APÓS este backfill não terão linha → o cliente as trata como pending → veem
--   o tutorial. Usuários antigos ainda podem reexecutá-lo manualmente em
--   Configurações → "Ver tutorial novamente" (replay puramente client-side, sem
--   alterar este status).
--
-- ESCOPO: puramente aditivo — uma tabela nova + RLS + grants + trigger de
-- updated_at (função public.set_updated_at já existe no baseline) + backfill
-- idempotente. Nada aqui toca em planos, assinatura, currículo, streak, quotas,
-- placement, RevenueCat, push ou qualquer outra feature (§17).
-- =============================================================================

-- ── Tabela: uma linha por usuário (user_id é a PK → unicidade natural) ───────
CREATE TABLE IF NOT EXISTS public.user_tutorial_progress (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Estado terminal persistido. 'pending' é o DEFAULT do banco, mas na prática a
  -- ausência de linha já representa "pending" no cliente; o valor só é gravado
  -- quando o usuário conclui ('completed') ou pula ('skipped').
  status       text NOT NULL DEFAULT 'pending',
  completed_at timestamptz,
  skipped_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT utp_status_domain CHECK (status IN ('pending', 'completed', 'skipped'))
);

COMMENT ON TABLE public.user_tutorial_progress IS
  'Status do tutorial interativo de primeiro acesso da Home (walkthrough). status ∈ {pending,completed,skipped}; ausência de linha = pending (usuário novo). completed_at/skipped_at registram o momento. Uma linha por user_id (PK). Backfill de rollout marca usuários pré-existentes como completed para não forçá-los ao tutorial.';

-- Mantém updated_at coerente em qualquer UPDATE (função do baseline).
DROP TRIGGER IF EXISTS trg_user_tutorial_progress_updated_at
  ON public.user_tutorial_progress;
CREATE TRIGGER trg_user_tutorial_progress_updated_at
  BEFORE UPDATE ON public.user_tutorial_progress
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- O cliente lê e escreve DIRETAMENTE a própria linha (é um estado do usuário,
-- sem gating server-side). RLS garante que cada um só enxerga/altera a própria
-- linha (auth.uid() = user_id), §18. Tabela nova não herda privilégio algum
-- neste banco, então todo GRANT é explícito.
ALTER TABLE public.user_tutorial_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utp_all_own ON public.user_tutorial_progress;
CREATE POLICY utp_all_own ON public.user_tutorial_progress
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.user_tutorial_progress FROM PUBLIC;
REVOKE ALL ON public.user_tutorial_progress FROM anon;
REVOKE ALL ON public.user_tutorial_progress FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_tutorial_progress TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_tutorial_progress TO service_role;

-- ── Backfill de rollout (idempotente) ────────────────────────────────────────
-- Marca TODOS os usuários que já existem no momento do deploy como 'completed'
-- (grandfathered), para que o tutorial de primeiro acesso NUNCA dispare
-- automaticamente para eles. Contas criadas depois deste ponto não terão linha
-- e serão tratadas como 'pending' pelo cliente → veem o tutorial. ON CONFLICT
-- DO NOTHING torna o backfill seguro para reexecução (nunca sobrescreve um
-- status já gravado por um usuário).
INSERT INTO public.user_tutorial_progress (user_id, status, completed_at)
SELECT u.id, 'completed', now()
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;
