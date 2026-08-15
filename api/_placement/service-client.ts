/**
 * SERVER-ONLY. Service-role Supabase client for placement reads/writes that are
 * server-authoritative: reading the PRIVATE answer key, checking answers, and
 * applying the (monotonic) result to the curriculum. Never import from a client
 * bundle.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../_env';

let cached: SupabaseClient | null = null;

export function getPlacementServiceClient(): SupabaseClient {
  if (cached) return cached;
  const { url, key } = getSupabaseServiceCredentials();
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
