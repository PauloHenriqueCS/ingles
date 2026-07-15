import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _serviceClient: SupabaseClient | null = null;

export function getJobsServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient;
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    throw new Error('Missing Supabase service role credentials (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}
