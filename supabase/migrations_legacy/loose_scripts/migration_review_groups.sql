-- GRUPOS DE REVISAO (Spaced Repetition v1)
-- Execute no Supabase SQL Editor

-- =====================================================================
-- 1. review_groups
-- =====================================================================

create table if not exists public.review_groups (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  source_review_id  uuid not null references public.english_reviews(id) on delete cascade,
  source_entry_date date,
  original_theme    text,
  status            text not null default 'scheduled'
                    check (status in ('scheduled', 'active', 'mastered')),
  review_level      integer not null default 0,
  next_review_at    timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- uma revisao gera no maximo um grupo por usuario
  constraint review_groups_user_review_unique unique (user_id, source_review_id)
);

alter table public.review_groups enable row level security;

create index if not exists review_groups_user_id_idx
  on public.review_groups(user_id);

create index if not exists review_groups_user_next_review_idx
  on public.review_groups(user_id, next_review_at);

drop policy if exists "rg_select" on public.review_groups;
drop policy if exists "rg_insert" on public.review_groups;
drop policy if exists "rg_update" on public.review_groups;
drop policy if exists "rg_delete" on public.review_groups;

create policy "rg_select" on public.review_groups
  for select to authenticated using (auth.uid() = user_id);

create policy "rg_insert" on public.review_groups
  for insert to authenticated with check (auth.uid() = user_id);

create policy "rg_update" on public.review_groups
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "rg_delete" on public.review_groups
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- 2. review_group_items
-- =====================================================================

create table if not exists public.review_group_items (
  id                uuid primary key default gen_random_uuid(),
  review_group_id   uuid not null references public.review_groups(id) on delete cascade,
  original_value    text not null,
  corrected_value   text not null,
  explanation       text,
  original_sentence text,
  created_at        timestamptz not null default now()
);

alter table public.review_group_items enable row level security;

create index if not exists review_group_items_group_idx
  on public.review_group_items(review_group_id);

drop policy if exists "rgi_select" on public.review_group_items;
drop policy if exists "rgi_insert" on public.review_group_items;
drop policy if exists "rgi_delete" on public.review_group_items;

-- Acesso via parent: usuario so ve itens dos proprios grupos
create policy "rgi_select" on public.review_group_items
  for select to authenticated using (
    exists (
      select 1 from public.review_groups rg
      where rg.id = review_group_id and rg.user_id = auth.uid()
    )
  );

create policy "rgi_insert" on public.review_group_items
  for insert to authenticated with check (
    exists (
      select 1 from public.review_groups rg
      where rg.id = review_group_id and rg.user_id = auth.uid()
    )
  );

create policy "rgi_delete" on public.review_group_items
  for delete to authenticated using (
    exists (
      select 1 from public.review_groups rg
      where rg.id = review_group_id and rg.user_id = auth.uid()
    )
  );
