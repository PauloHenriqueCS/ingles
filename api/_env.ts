/**
 * SERVER-ONLY: sanitized environment variable reads for Supabase credentials.
 *
 * Root cause of a production incident: Vercel's stored value for
 * SUPABASE_SERVICE_ROLE_KEY carried a leading UTF-8 BOM (U+FEFF, pasted in
 * from whatever source it was copied from). supabase-js sends that value
 * verbatim as the `apikey` header, and the fetch/undici header encoder
 * rejects any header value containing a character above 255 with
 * "Cannot convert argument to a ByteString" — every RPC call made with a
 * client built from the raw env var threw, which getCurrentUserPlanEntitlements
 * (unlike callers that fail open, e.g. the rate limiter) surfaced as a hard
 * 500. Stripping a leading BOM and surrounding whitespace here makes every
 * credential read immune to this regardless of how the value gets set again.
 */
const BOM_PATTERN = new RegExp('^\u{FEFF}', 'u');

function stripBom(value: string): string {
  return value.replace(BOM_PATTERN, '').trim();
}

export function readEnv(name: string): string {
  return stripBom(process.env[name] ?? '');
}

export interface SupabaseCredentials {
  url: string;
  key: string;
}

export function getSupabaseServiceCredentials(): SupabaseCredentials {
  return { url: readEnv('VITE_SUPABASE_URL'), key: readEnv('SUPABASE_SERVICE_ROLE_KEY') };
}

export function getSupabaseAnonCredentials(): SupabaseCredentials {
  return { url: readEnv('VITE_SUPABASE_URL'), key: readEnv('VITE_SUPABASE_ANON_KEY') };
}
