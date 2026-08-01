-- Run this in the Supabase SQL Editor

create table if not exists public.grammar_explanations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  content    jsonb not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive unique index prevents duplicate entries for the same topic
create unique index if not exists grammar_explanations_name_lower_idx
  on public.grammar_explanations (lower(name));

alter table public.grammar_explanations enable row level security;

create policy "anon_all" on public.grammar_explanations
  for all to anon using (true) with check (true);
