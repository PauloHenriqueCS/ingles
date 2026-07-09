-- Run this in the Supabase SQL Editor

create table if not exists public.writing_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date unique not null,
  month integer not null,
  year integer not null,
  theme text not null default '',
  grammar_goal text,
  main_tense text,
  title text,
  original_text text,
  corrected_text text,
  notes text,
  main_errors text,
  difficulty text check (difficulty in ('facil', 'medio', 'dificil') or difficulty is null),
  status text not null default 'nao-iniciado'
    check (status in ('nao-iniciado', 'escrito', 'corrigido', 'revisado')),
  word_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.writing_entries enable row level security;

-- Personal app: allow all for anon (add user_id filter when auth is added)
create policy "anon_all" on public.writing_entries
  for all to anon using (true) with check (true);

create index if not exists writing_entries_year_month_idx
  on public.writing_entries (year, month);

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger writing_entries_updated_at
  before update on public.writing_entries
  for each row execute function update_updated_at();
