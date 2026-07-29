-- =============================================================================
-- MIGRATION: 20260727230500_grant_signup_trial
-- Projeto: app de inglês (ingles) — Domínio de assinaturas
--
-- Concede automaticamente o plano interno `trial` (7 dias) a todo usuário
-- novo, no momento do cadastro — a peça que a auditoria encontrou faltando
-- no domínio de assinaturas: hoje NENHUM caminho de código concede o trial.
-- Um cadastro novo cai direto no plano padrão (`plano-teste-lojas`,
-- is_default = TRUE), que nunca teve conversation.enabled e existe como
-- fallback de segurança, não como onboarding.
--
-- PADRÃO: trigger AFTER INSERT ON auth.users, o "handle_new_user" clássico
-- do Supabase. Funciona para QUALQUER caminho de criação de conta
-- (email/senha, magic link, OAuth, convite admin), é atômico com a própria
-- criação da conta (mesma transação) e nunca depende do cliente chamar um
-- endpoint depois do signup — um cliente que fecha a aba cedo demais, ou um
-- client malicioso que simplesmente nunca chama esse endpoint, nunca poderia
-- pular a concessão. "Não confiar no plano enviado pelo frontend" se aplica
-- aqui por extensão: o cliente não participa em nada da decisão de conceder
-- o trial, só lê o resultado depois via GET /api/subscription/status.
--
-- SEGURANÇA CRÍTICA — NUNCA DERRUBAR O CADASTRO: uma trigger AFTER INSERT em
-- auth.users roda DENTRO da transação de criação da conta. Uma exceção não
-- capturada aqui derrubaria o cadastro inteiro. Por isso toda a lógica de
-- concessão fica dentro de um EXCEPTION WHEN OTHERS que sempre retorna NEW:
-- uma falha ao conceder o trial (ex.: plano trial sem versão publicada,
-- tabela ausente) NUNCA pode impedir a criação da conta — o pior caso é o
-- usuário cair no mesmo fallback padrão de admin_resolve_effective_plan_v1
-- que já existe hoje, sem esta migration.
--
-- FONTE DA DURAÇÃO DO TRIAL (nesta ordem, primeira que existir):
--   1. plan_trial_policies (trial_enabled, duration_days, max_grants_per_user)
--      — a tabela oficial para isso, já existente com RLS restrita ao
--      ingles-dashboad, mas hoje vazia (auditoria confirmou 0 linhas).
--   2. plans.trial_days do próprio plano `trial` (hoje = 7) — fallback,
--      nunca um literal novo escolhido por esta migration.
-- Se nenhuma das duas fontes indicar uma duração válida (> 0) e habilitada,
-- ou se o plano `trial` não existir, a função não concede nada — nunca
-- inventa um número.
--
-- IDEMPOTÊNCIA DE CONCESSÃO: nunca concede além de max_grants_per_user
-- (default 1 quando plan_trial_policies não tem linha) — conta atribuições
-- PASSADAS com origin = 'trial' para este usuário e este plano. Numa trigger
-- de INSERT o usuário é sempre nesse instante novo, então isso só importa se
-- este mesmo user_id for reinserido em auth.users (não deveria acontecer),
-- mas o guard não custa nada e documenta a regra explicitamente.
--
-- created_by = o próprio usuário novo (NEW.id): não existe um "ator sistema"
-- em admin_users para atribuir aqui, e user_plan_assignments.created_by é
-- NOT NULL com FK para auth.users — usar o próprio usuário é a opção mais
-- honesta (é uma auto-concessão de onboarding, não uma ação administrativa).
--
-- 100% idempotente e aditiva: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF
-- EXISTS antes de recriar. Nenhuma tabela nova, nenhum DROP destrutivo.
-- Aplicar neste banco está fora do escopo desta etapa.
--
-- Timestamp desta migration e da irmã 20260727230600 (essencial_plus_commercial_plans,
-- renomeada de 20260727230000 por colisão com a migration de pacotes de
-- minutos — ver o próprio cabeçalho dela) seguem a regra já documentada em
-- supabase/MIGRATIONS.md (Etapa 2A): estritamente posterior à
-- maior versão conhecida em schema_migrations no momento da auditoria
-- (20260727224400, confirmado via list_migrations em modo leitura) — não
-- apenas posterior aos arquivos locais. Reconferir list_migrations
-- imediatamente antes de aplicar, pois o ingles-dashboad pode ter aplicado
-- algo nesse intervalo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.grant_signup_trial_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_trial_plan_id uuid;
  v_trial_enabled boolean;
  v_duration_days integer;
  v_max_grants integer;
  v_prior_grants integer;
BEGIN
  SELECT id INTO v_trial_plan_id FROM public.plans WHERE code = 'trial';
  IF v_trial_plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT trial_enabled, duration_days, max_grants_per_user
    INTO v_trial_enabled, v_duration_days, v_max_grants
  FROM public.plan_trial_policies
  WHERE plan_id = v_trial_plan_id;

  IF NOT FOUND THEN
    SELECT trial_days INTO v_duration_days FROM public.plans WHERE id = v_trial_plan_id;
    v_trial_enabled := v_duration_days IS NOT NULL AND v_duration_days > 0;
    v_max_grants := 1;
  END IF;

  IF NOT COALESCE(v_trial_enabled, FALSE) OR v_duration_days IS NULL OR v_duration_days <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_prior_grants
  FROM public.user_plan_assignments
  WHERE user_id = NEW.id AND plan_id = v_trial_plan_id AND origin = 'trial';

  IF v_prior_grants >= COALESCE(v_max_grants, 1) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_plan_assignments (
    user_id, plan_id, version_policy, origin, starts_at, ends_at, status, created_by, reason
  ) VALUES (
    NEW.id, v_trial_plan_id, 'follow_current_published', 'trial',
    now(), now() + (v_duration_days::text || ' days')::interval, 'active',
    NEW.id, 'Concessão automática do teste gratuito no cadastro (grant_signup_trial_v1)'
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Nunca derruba o cadastro por causa de uma falha na concessão do trial
  -- (ver cabeçalho). O usuário simplesmente cai no fallback padrão de
  -- admin_resolve_effective_plan_v1, exatamente como acontecia antes desta
  -- migration existir.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grant_signup_trial ON auth.users;
CREATE TRIGGER trg_grant_signup_trial
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.grant_signup_trial_v1();
