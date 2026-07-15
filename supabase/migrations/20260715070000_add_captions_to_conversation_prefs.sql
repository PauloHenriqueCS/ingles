alter table public.ai_conversation_preferences
  add column if not exists captions_enabled boolean not null default true;
