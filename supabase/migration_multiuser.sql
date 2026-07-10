-- MIGRACAO MULTIUSUARIO
-- Execute no Supabase SQL Editor

-- =====================================================================
-- PASSO 0: Descubra seu user_id antes de continuar
--   SELECT id FROM auth.users;
-- Guarde o UUID para usar no PASSO 1a abaixo.
-- =====================================================================

-- =====================================================================
-- 1. writing_entries -- adicionar user_id e corrigir RLS
-- =====================================================================

alter table public.writing_entries
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists writing_entries_user_id_idx
  on public.writing_entries(user_id);

create index if not exists writing_entries_user_date_idx
  on public.writing_entries(user_id, entry_date desc);

-- PASSO 1a: Associe os dados existentes ao seu usuario.
-- Substitua pelo UUID obtido no PASSO 0 e execute esta linha separadamente:
-- UPDATE public.writing_entries SET user_id = 'cole-seu-uuid-aqui' WHERE user_id IS NULL;

-- Trocar unicidade de (entry_date) para (user_id, entry_date)
alter table public.writing_entries
  drop constraint if exists writing_entries_entry_date_key;

create unique index if not exists writing_entries_user_entry_date_unique
  on public.writing_entries(user_id, entry_date);

-- Remover politicas antigas abertas
drop policy if exists "anon_all"          on public.writing_entries;
drop policy if exists "authenticated_all" on public.writing_entries;
drop policy if exists "we_select"         on public.writing_entries;
drop policy if exists "we_insert"         on public.writing_entries;
drop policy if exists "we_update"         on public.writing_entries;
drop policy if exists "we_delete"         on public.writing_entries;

-- Politicas por usuario
create policy "we_select" on public.writing_entries
  for select to authenticated using (auth.uid() = user_id);

create policy "we_insert" on public.writing_entries
  for insert to authenticated with check (auth.uid() = user_id);

create policy "we_update" on public.writing_entries
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "we_delete" on public.writing_entries
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- 2. generated_themes -- corrigir RLS (user_id ja existe na tabela)
-- =====================================================================

drop policy if exists "anon_all"   on public.generated_themes;
drop policy if exists "gt_select"  on public.generated_themes;
drop policy if exists "gt_insert"  on public.generated_themes;
drop policy if exists "gt_update"  on public.generated_themes;
drop policy if exists "gt_delete"  on public.generated_themes;

create policy "gt_select" on public.generated_themes
  for select to authenticated using (auth.uid() = user_id);

create policy "gt_insert" on public.generated_themes
  for insert to authenticated with check (auth.uid() = user_id);

create policy "gt_update" on public.generated_themes
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "gt_delete" on public.generated_themes
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- 3. english_reviews -- criar tabela com RLS completo
-- =====================================================================

create table if not exists public.english_reviews (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  original_text     text not null,
  corrected_text    text,
  score             integer not null,
  level             text not null,
  grammar           integer not null default 0,
  vocabulary        integer not null default 0,
  naturalness       integer not null default 0,
  fluency           integer not null default 0,
  summary           text,
  main_mistakes     jsonb not null default '[]',
  new_vocabulary    jsonb not null default '[]',
  objective_feedback text,
  next_practice     text,
  category          text,
  difficulty        text,
  objective         text,
  created_at        timestamptz not null default now()
);

alter table public.english_reviews enable row level security;

create index if not exists english_reviews_user_id_idx
  on public.english_reviews(user_id);

create index if not exists english_reviews_user_created_idx
  on public.english_reviews(user_id, created_at desc);

drop policy if exists "er_select" on public.english_reviews;
drop policy if exists "er_insert" on public.english_reviews;
drop policy if exists "er_update" on public.english_reviews;
drop policy if exists "er_delete" on public.english_reviews;

create policy "er_select" on public.english_reviews
  for select to authenticated using (auth.uid() = user_id);

create policy "er_insert" on public.english_reviews
  for insert to authenticated with check (auth.uid() = user_id);

create policy "er_update" on public.english_reviews
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "er_delete" on public.english_reviews
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- 4. english_learning_memory -- criar tabela com RLS completo
-- =====================================================================

create table if not exists public.english_learning_memory (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null unique references auth.users(id) on delete cascade,
  current_level           text not null default 'A1',
  average_score           integer not null default 0,
  weakest_skill           text,
  strongest_skill         text,
  recurring_mistakes      jsonb not null default '[]',
  grammar_focus           jsonb not null default '[]',
  vocabulary_learned      jsonb not null default '[]',
  vocabulary_to_review    jsonb not null default '[]',
  recommended_next_focus  text,
  recommended_next_theme  text,
  teacher_summary         text,
  total_reviews           integer not null default 0,
  practiced_days          integer not null default 0,
  current_streak          integer not null default 0,
  last_review_at          timestamptz,
  updated_at              timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

alter table public.english_learning_memory enable row level security;

create index if not exists english_learning_memory_user_idx
  on public.english_learning_memory(user_id);

drop policy if exists "elm_select" on public.english_learning_memory;
drop policy if exists "elm_insert" on public.english_learning_memory;
drop policy if exists "elm_update" on public.english_learning_memory;
drop policy if exists "elm_delete" on public.english_learning_memory;

create policy "elm_select" on public.english_learning_memory
  for select to authenticated using (auth.uid() = user_id);

create policy "elm_insert" on public.english_learning_memory
  for insert to authenticated with check (auth.uid() = user_id);

create policy "elm_update" on public.english_learning_memory
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "elm_delete" on public.english_learning_memory
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- 5. grammar_explanations -- cache global, so autenticados escrevem
-- =====================================================================

create table if not exists public.grammar_explanations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  content    jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists grammar_explanations_name_lower_idx
  on public.grammar_explanations (lower(name));

alter table public.grammar_explanations enable row level security;

drop policy if exists "anon_all"  on public.grammar_explanations;
drop policy if exists "ge_select" on public.grammar_explanations;
drop policy if exists "ge_insert" on public.grammar_explanations;
drop policy if exists "ge_update" on public.grammar_explanations;

create policy "ge_select" on public.grammar_explanations
  for select to authenticated using (true);

create policy "ge_insert" on public.grammar_explanations
  for insert to authenticated with check (true);

create policy "ge_update" on public.grammar_explanations
  for update to authenticated using (true) with check (true);
