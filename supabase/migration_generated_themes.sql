-- Run this in the Supabase SQL Editor

create table if not exists public.generated_themes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id),
  title            text not null,
  description      text,
  grammar_focus    text[],
  activity_type    text,
  context          text,
  semantic_summary text,
  difficulty       text check (difficulty in ('easy', 'medium', 'hard')),
  vocabulary       text[],
  created_at       timestamptz not null default now(),
  status           text not null default 'generated'
    check (status in ('generated', 'completed', 'skipped', 'regenerated'))
);

alter table public.generated_themes enable row level security;

create policy "anon_all" on public.generated_themes
  for all to anon using (true) with check (true);

create index if not exists generated_themes_user_created_idx
  on public.generated_themes (user_id, created_at desc);
