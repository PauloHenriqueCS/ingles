-- =============================================================================
-- MIGRATION: 20260718220000_listening_multi_story_per_day
-- Projeto: Lemon
--
-- APLICAR UMA UNICA VEZ no Supabase SQL Editor.
-- Esta migration NAO modifica nem remove dados existentes.
--
-- Contexto: public.user_listening_assignments tinha UNIQUE (user_id,
-- activity_date), limitando estruturalmente cada usuario a uma unica
-- historia por dia, mesmo quando o plano comercial configura
-- listening_stories_per_day > 1. A coluna estavel que identifica a
-- historia/atividade atribuida e "episode_id" (FK para listening_episodes,
-- ja indexada via idx_ula_episode_id). Esta migration substitui a
-- unicidade por (user_id, activity_date, episode_id): continua impedindo
-- duas atribuicoes da MESMA historia no mesmo dia, mas permite historias
-- distintas no mesmo dia ate o limite comercial do plano (aplicado na
-- camada de entitlements, nao no banco).
--
-- Nao remove nem apaga nenhuma linha. A constraint antiga so e removida
-- apos a nova ja existir, entao a tabela nunca fica sem uma protecao de
-- unicidade equivalente durante a aplicacao.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_listening_assignments'::regclass
      and conname = 'user_listening_assignments_user_date_episode_key'
  ) then
    alter table public.user_listening_assignments
      add constraint user_listening_assignments_user_date_episode_key
      unique (user_id, activity_date, episode_id);
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_listening_assignments'::regclass
      and conname = 'user_listening_assignments_user_id_activity_date_key'
  ) then
    alter table public.user_listening_assignments
      drop constraint user_listening_assignments_user_id_activity_date_key;
  end if;
end $$;

-- Após aplicar: execute supabase/verify_schema.sql para verificar o estado
-- (schema.sql/verify_schema.sql já estavam desatualizados antes desta
-- migration em relação às tabelas comerciais/listening mais recentes; não
-- foram tocados aqui por estarem fora do escopo desta etapa).
