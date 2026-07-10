-- Run this in the Supabase SQL Editor
-- Adds RLS policy for authenticated users on writing_entries

create policy "authenticated_all" on public.writing_entries
  for all to authenticated using (true) with check (true);
