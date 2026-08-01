alter table public.writing_entries
  add column if not exists ai_review jsonb;
