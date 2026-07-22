import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../../../../api/_env';

let _serviceClient: SupabaseClient | null = null;

export function getListeningServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient;
  const { url, key } = getSupabaseServiceCredentials();
  if (!url || !key) {
    throw new Error('Missing Supabase service role credentials');
  }
  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}
