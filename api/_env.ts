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

/**
 * Server-only secret for deterministic HMAC-SHA256 hashing of communication
 * destinations (email/phone/push token) before they are stored in
 * user_communication_blocks.destination_hash — never a plain SHA of the raw
 * value, which would be brute-forceable for predictable inputs like emails.
 * Empty string when unset; callers must treat that as "hashing unavailable"
 * and never fall back to storing the raw destination.
 */
export function getCommunicationSuppressionHmacSecret(): string {
  return readEnv('COMMUNICATION_SUPPRESSION_HMAC_SECRET');
}

// ── RevenueCat (server-only secrets — see .env.example for the full set,
// including the client-safe VITE_REVENUECAT_APPLE_API_KEY /
// VITE_REVENUECAT_GOOGLE_API_KEY read directly by src/lib/revenueCat/, never
// through this file) ─────────────────────────────────────────────────────────

/** Shared secret RevenueCat sends as the webhook's Authorization header.
 *  Empty string when unset — callers must fail closed, never skip the check. */
export function getRevenueCatWebhookAuthSecret(): string {
  return readEnv('REVENUECAT_WEBHOOK_AUTH_SECRET');
}

/** HMAC-SHA256 signing secret for X-RevenueCat-Webhook-Signature. Empty
 *  string means signing is not configured yet in the RevenueCat dashboard —
 *  callers must treat that as "HMAC check unavailable", never as "valid". */
export function getRevenueCatWebhookHmacSecret(): string {
  return readEnv('REVENUECAT_WEBHOOK_HMAC_SECRET');
}

/** RevenueCat REST API secret key, for server-initiated CustomerInfo lookups
 *  (POST /api/subscription/sync). Empty string when unset. */
export function getRevenueCatApiSecretKey(): string {
  return readEnv('REVENUECAT_API_SECRET_KEY');
}
