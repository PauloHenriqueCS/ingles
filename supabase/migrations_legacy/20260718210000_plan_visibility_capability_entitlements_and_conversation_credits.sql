-- =============================================================================
-- MIGRATION: 20260718210000_plan_visibility_capability_entitlements_and_conversation_credits
-- Projeto: Lemon
--
-- APLICAR UMA UNICA VEZ no Supabase SQL Editor.
-- Esta migration NAO modifica nem remove dados existentes.
--
-- Contexto: as tabelas comerciais (plans, plan_versions, capability_definitions,
-- plan_capability_values, user_plan_assignments, user_capability_overrides,
-- user_access_controls, admin_*) ja existem no projeto remoto "ingles",
-- aplicadas fora deste repositorio (migracao remota "capability_schema_evolution").
-- Esta migration REUTILIZA essa arquitetura em vez de criar uma paralela:
--   - plan_capability_values (plan_version_id, capability_key) ja e a estrutura
--     generica de "limites por versao do plano" -- cada uma das 4 funcionalidades
--     principais (escrita, listening, pronuncia, conversacao) e registrada como
--     linhas em capability_definitions, nao como uma nova tabela de colunas fixas.
--   - Nenhum valor comercial e inserido para a versao ja publicada (Gratuito v1);
--     a trigger existente tg_plan_capability_values_immutability ja impede
--     qualquer escrita em plan_capability_values para versoes published/retired/
--     discarded, entao isso e reforcado pelo proprio banco.
--   - capability_key "conversation.realtime.seconds.monthly" ja existe e e
--     reutilizada como o limite mensal de conversacao incluido no plano.
--
-- NOTA DE ENCODING: textos em portugues neste arquivo usam apenas ASCII (sem
-- acentos) de proposito, para casar exatamente com o que foi executado no
-- SQL Editor remoto ao aplicar esta migration.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Visibilidade publica do plano
-- ─────────────────────────────────────────────────────────────────────────────
-- Nenhum campo equivalente (is_public/visible/visibility/available_for_signup/
-- publicly_available) existe em public.plans -- coluna nova.
-- DEFAULT true + NOT NULL garante que planos existentes recebam
-- is_visible_to_users = true automaticamente, sem UPDATE explicito.

alter table public.plans
  add column if not exists is_visible_to_users boolean not null default true;

comment on column public.plans.is_visible_to_users is
  'Quando false, o plano nao aparece publicamente (ex: pagina de precos), mas continua podendo ser atribuido manualmente por um administrador. Nunca pode ser true=false junto com is_default=true (ver chk_plans_default_must_be_visible).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.plans'::regclass
      and conname = 'chk_plans_default_must_be_visible'
  ) then
    alter table public.plans
      add constraint chk_plans_default_must_be_visible
      check (not (is_default and not is_visible_to_users))
      not valid;
  end if;
end $$;

alter table public.plans
  validate constraint chk_plans_default_must_be_visible;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2/3/4. Ativacao das 4 funcionalidades + limites comerciais + "Ilimitado"
-- ─────────────────────────────────────────────────────────────────────────────
-- Reutiliza capability_definitions (catalogo) + plan_capability_values
-- (valor por versao de plano, ja existentes). Esta migration adiciona apenas
-- as DEFINICOES (metadados) das capabilities -- nenhuma linha e inserida em
-- plan_capability_values, entao nenhuma versao publicada recebe valores
-- comerciais inventados. A configuracao real sera feita pelo backend
-- administrativo em uma nova versao draft.
--
-- Cada limite numerico ganha uma capability irma "<mesma chave>.unlimited"
-- (boolean). Esse booleano e a UNICA fonte de verdade para "ilimitado" --
-- nunca um valor magico (999999, -1, NULL ou zero) no campo numerico.
--
-- Periodos fixos (mapeados para o enum ja existente de allowed_periods):
--   dia      -> 'day'      (geracoes de tema, revisoes, historias, avaliacoes)
--   mes      -> 'month'    (conversacao incluida por mes)
--   request  -> 'request'  (limite por texto / por gravacao)
--   nenhum   -> 'none'     (flags booleanas: enabled / unlimited / extra_purchase)

insert into public.capability_definitions
  (key, category, group_key, label, description, value_type, unit, default_period, default_value, display_order, active)
values
  -- Escrita
  ('writing.enabled', 'feature', 'writing', 'Escrita habilitada', 'Ativa a atividade de escrita diaria para o plano.', 'boolean', null, 'none', 'false'::jsonb, 1, true),
  ('writing.theme_generations_per_day', 'quota', 'writing', 'Geracoes de tema por dia', 'Quantidade de missoes/temas de escrita que podem ser gerados por dia.', 'integer', 'generations', 'day', '0'::jsonb, 2, true),
  ('writing.theme_generations_per_day.unlimited', 'quota', 'writing', 'Geracoes de tema ilimitadas', 'Quando verdadeiro, ignora o limite diario de geracoes de tema.', 'boolean', null, 'none', 'false'::jsonb, 3, true),
  ('writing.max_characters_per_text', 'field_limit', 'writing', 'Caracteres maximos por texto', 'Quantidade maxima de caracteres permitida em um unico texto de escrita.', 'integer', 'characters', 'request', '0'::jsonb, 4, true),
  ('writing.max_characters_per_text.unlimited', 'field_limit', 'writing', 'Caracteres por texto ilimitados', 'Quando verdadeiro, ignora o limite de caracteres por texto.', 'boolean', null, 'none', 'false'::jsonb, 5, true),
  ('writing.reviews_per_day', 'quota', 'writing', 'Revisoes por dia', 'Quantidade de revisoes de IA de textos de escrita permitidas por dia.', 'integer', 'reviews', 'day', '0'::jsonb, 6, true),
  ('writing.reviews_per_day.unlimited', 'quota', 'writing', 'Revisoes por dia ilimitadas', 'Quando verdadeiro, ignora o limite diario de revisoes.', 'boolean', null, 'none', 'false'::jsonb, 7, true),

  -- Listening / historias
  ('listening.enabled', 'feature', 'listening', 'Listening habilitado', 'Ativa a atividade de listening (historias) para o plano.', 'boolean', null, 'none', 'false'::jsonb, 1, true),
  ('listening.stories_per_day', 'quota', 'listening', 'Historias por dia', 'Quantidade de historias de listening que podem ser consumidas por dia.', 'integer', 'stories', 'day', '0'::jsonb, 2, true),
  ('listening.stories_per_day.unlimited', 'quota', 'listening', 'Historias por dia ilimitadas', 'Quando verdadeiro, ignora o limite diario de historias.', 'boolean', null, 'none', 'false'::jsonb, 3, true),

  -- Treino de pronuncia
  ('pronunciation.enabled', 'feature', 'pronunciation', 'Treino de pronuncia habilitado', 'Ativa o treino de pronuncia para o plano.', 'boolean', null, 'none', 'false'::jsonb, 1, true),
  ('pronunciation.evaluations_per_day', 'quota', 'pronunciation', 'Avaliacoes por dia', 'Quantidade de avaliacoes de pronuncia permitidas por dia.', 'integer', 'evaluations', 'day', '0'::jsonb, 2, true),
  ('pronunciation.evaluations_per_day.unlimited', 'quota', 'pronunciation', 'Avaliacoes por dia ilimitadas', 'Quando verdadeiro, ignora o limite diario de avaliacoes.', 'boolean', null, 'none', 'false'::jsonb, 3, true),
  ('pronunciation.max_recording_seconds', 'field_limit', 'pronunciation', 'Duracao maxima da gravacao (segundos)', 'Duracao maxima, em segundos, de uma gravacao de pronuncia.', 'integer', 'seconds', 'request', '0'::jsonb, 4, true),
  ('pronunciation.max_recording_seconds.unlimited', 'field_limit', 'pronunciation', 'Duracao de gravacao ilimitada', 'Quando verdadeiro, ignora o limite de duracao da gravacao.', 'boolean', null, 'none', 'false'::jsonb, 5, true),

  -- Conversacao por voz (conversation.realtime.seconds.monthly ja existe e e reutilizada)
  ('conversation.enabled', 'feature', 'conversation', 'Conversacao por voz habilitada', 'Ativa a conversacao por voz com a Lemon para o plano.', 'boolean', null, 'none', 'false'::jsonb, 0, true),
  ('conversation.realtime.seconds.monthly.unlimited', 'quota', 'conversation', 'Tempo mensal de conversacao ilimitado', 'Quando verdadeiro, ignora o limite mensal de segundos de conversacao (conversation.realtime.seconds.monthly).', 'boolean', null, 'none', 'false'::jsonb, 2, true),
  ('conversation.max_recording_seconds', 'field_limit', 'conversation', 'Duracao maxima da gravacao (segundos)', 'Duracao maxima, em segundos, de uma gravacao/turno de conversacao.', 'integer', 'seconds', 'request', '0'::jsonb, 3, true),
  ('conversation.max_recording_seconds.unlimited', 'field_limit', 'conversation', 'Duracao de gravacao ilimitada', 'Quando verdadeiro, ignora o limite de duracao da gravacao de conversacao.', 'boolean', null, 'none', 'false'::jsonb, 4, true),
  ('conversation.extra_purchase_enabled', 'feature', 'conversation', 'Permite compra de minutos adicionais', 'Quando verdadeiro, o usuario deste plano pode comprar minutos adicionais de conversacao (saldo em user_conversation_credits). Nao implementa checkout nem precos.', 'boolean', null, 'none', 'false'::jsonb, 5, true)
on conflict (key) do nothing;

-- Guarda generica contra valores numericos negativos em qualquer capability
-- (definicao e valor por versao), sem depender de numeros magicos por chave.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.capability_definitions'::regclass
      and conname = 'chk_capability_definitions_default_value_non_negative'
  ) then
    alter table public.capability_definitions
      add constraint chk_capability_definitions_default_value_non_negative
      check (default_value is null or jsonb_typeof(default_value) <> 'number' or (default_value::text)::numeric >= 0)
      not valid;
  end if;
end $$;

alter table public.capability_definitions
  validate constraint chk_capability_definitions_default_value_non_negative;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.plan_capability_values'::regclass
      and conname = 'chk_plan_capability_values_value_non_negative'
  ) then
    alter table public.plan_capability_values
      add constraint chk_plan_capability_values_value_non_negative
      check (jsonb_typeof(value) <> 'number' or (value::text)::numeric >= 0)
      not valid;
  end if;
end $$;

alter table public.plan_capability_values
  validate constraint chk_plan_capability_values_value_non_negative;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5/6. Minutos adicionais de conversacao: permissao (acima, capability
--      conversation.extra_purchase_enabled) + saldo comprado/concedido
-- ─────────────────────────────────────────────────────────────────────────────
-- user_capability_overrides foi avaliada e NAO e equivalente: ela sobrescreve
-- a REGRA de uma capability para um usuario durante uma janela de tempo
-- (add/replace/unlimited/disable), sem semantica de saldo consumivel
-- (total/remaining) nem proveniencia de compra (source/external_reference).
-- Nao ha outra tabela de creditos, franquias ou saldo no projeto -- nova tabela.

create table if not exists public.user_conversation_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  total_seconds integer not null,
  remaining_seconds integer not null,
  source text not null,
  external_reference text,
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_ucc_source check (source in ('purchase', 'admin_grant', 'promotion', 'refund')),
  constraint chk_ucc_total_seconds_positive check (total_seconds > 0),
  constraint chk_ucc_remaining_seconds_non_negative check (remaining_seconds >= 0),
  constraint chk_ucc_remaining_le_total check (remaining_seconds <= total_seconds)
);

comment on table public.user_conversation_credits is
  'Saldo de segundos adicionais de conversacao comprados ou concedidos a um usuario, alem do limite incluido no plano (conversation.realtime.seconds.monthly). Nao implementa checkout, precos nem consumo - apenas o ledger. Consumo e bloqueio no app ficam para uma etapa futura.';

create index if not exists idx_user_conversation_credits_user_id
  on public.user_conversation_credits (user_id);

create index if not exists idx_user_conversation_credits_remaining_positive
  on public.user_conversation_credits (remaining_seconds)
  where remaining_seconds > 0;

create index if not exists idx_user_conversation_credits_expires_at
  on public.user_conversation_credits (expires_at)
  where expires_at is not null;

create index if not exists idx_user_conversation_credits_external_reference
  on public.user_conversation_credits (external_reference)
  where external_reference is not null;

drop trigger if exists trg_user_conversation_credits_updated_at on public.user_conversation_credits;
create trigger trg_user_conversation_credits_updated_at
  before update on public.user_conversation_credits
  for each row execute function public.set_updated_at();

-- RLS: mesmo padrao ja usado em plan_capability_values / user_capability_overrides
-- (is_active_admin() para leitura, can_manage_plans() para escrita). Nenhuma
-- policy para authenticated/anon alem dessas -- usuario comum nao le nem grava,
-- nem o proprio saldo nem o de outros. service_role contorna RLS por padrao no
-- Supabase e nunca e exposto ao frontend.

alter table public.user_conversation_credits enable row level security;

drop policy if exists user_conversation_credits_read on public.user_conversation_credits;
create policy user_conversation_credits_read
  on public.user_conversation_credits
  for select
  to public
  using (is_active_admin());

drop policy if exists user_conversation_credits_write on public.user_conversation_credits;
create policy user_conversation_credits_write
  on public.user_conversation_credits
  for insert
  to public
  with check (can_manage_plans());

drop policy if exists user_conversation_credits_update on public.user_conversation_credits;
create policy user_conversation_credits_update
  on public.user_conversation_credits
  for update
  to public
  using (can_manage_plans());

-- Apos aplicar: execute supabase/verify_schema.sql para verificar o estado
-- (schema.sql e verify_schema.sql ja estavam desatualizados em relacao as
-- tabelas comerciais/ai-gateway aplicadas fora deste repositorio antes desta
-- migration; nao foram tocados aqui por estarem fora do escopo desta etapa).
