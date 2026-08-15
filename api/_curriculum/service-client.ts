/**
 * SERVER-ONLY. Service-role Supabase client for curriculum writes/reads that are
 * server-authoritative (progression, preferences bootstrap). Never import from a
 * client bundle.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../_env';

let cached: SupabaseClient | null = null;

export function getCurriculumServiceClient(): SupabaseClient {
  if (cached) return cached;
  const { url, key } = getSupabaseServiceCredentials();
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
