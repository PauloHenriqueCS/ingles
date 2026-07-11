-- TENTATIVAS DE REVISAO (Spaced Repetition step 4)
-- Execute no Supabase SQL Editor

-- =====================================================================
-- 1. review_attempts
-- =====================================================================

create table if not exists public.review_attempts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  review_group_id   uuid not null references public.review_groups(id) on delete cascade,
  source_entry_date date,
  submitted_text    text,
  overall_result    text not null check (overall_result in ('passed', 'failed')),
  created_at        timestamptz not null default now()
);

alter table public.review_attempts enable row level security;

create index if not exists review_attempts_user_id_idx
  on public.review_attempts(user_id);

create index if not exists review_attempts_group_id_idx
  on public.review_attempts(review_group_id);

drop policy if exists "ra_select" on public.review_attempts;
drop policy if exists "ra_insert" on public.review_attempts;
drop policy if exists "ra_delete" on public.review_attempts;

create policy "ra_select" on public.review_attempts
  for select to authenticated using (auth.uid() = user_id);

create policy "ra_insert" on public.review_attempts
  for insert to authenticated with check (auth.uid() = user_id);

create policy "ra_delete" on public.review_attempts
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- 2. review_attempt_items
-- =====================================================================

create table if not exists public.review_attempt_items (
  id                   uuid primary key default gen_random_uuid(),
  review_attempt_id    uuid not null references public.review_attempts(id) on delete cascade,
  review_group_item_id uuid references public.review_group_items(id) on delete set null,
  required_word        text not null,
  status               text not null
                       check (status in ('correct', 'incorrect_spelling', 'incorrect_usage', 'missing', 'forced_usage')),
  used_excerpt         text,
  explanation          text not null,
  suggested_correction text,
  created_at           timestamptz not null default now()
);

alter table public.review_attempt_items enable row level security;

create index if not exists review_attempt_items_attempt_idx
  on public.review_attempt_items(review_attempt_id);

drop policy if exists "rai_select" on public.review_attempt_items;
drop policy if exists "rai_insert" on public.review_attempt_items;
drop policy if exists "rai_delete" on public.review_attempt_items;

create policy "rai_select" on public.review_attempt_items
  for select to authenticated using (
    exists (
      select 1 from public.review_attempts ra
      where ra.id = review_attempt_id and ra.user_id = auth.uid()
    )
  );

create policy "rai_insert" on public.review_attempt_items
  for insert to authenticated with check (
    exists (
      select 1 from public.review_attempts ra
      where ra.id = review_attempt_id and ra.user_id = auth.uid()
    )
  );

create policy "rai_delete" on public.review_attempt_items
  for delete to authenticated using (
    exists (
      select 1 from public.review_attempts ra
      where ra.id = review_attempt_id and ra.user_id = auth.uid()
    )
  );
