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

/** Comma-separated Supabase UUIDs explicitly allowed to apply SANDBOX (test)
 *  purchases on the PRODUCTION deployment — Google Play Internal Testing /
 *  license testers, whose purchases are always is_sandbox=true even though the
 *  app talks to the production backend. SERVER-ONLY: never a VITE_ var, never
 *  exposed to the client. Empty set when unset — production then blocks every
 *  sandbox event exactly as before. UUID matching is case-insensitive. */
export function getRevenueCatSandboxTestUserIds(): Set<string> {
  return new Set(
    readEnv('REVENUECAT_SANDBOX_TEST_USER_IDS')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

// ── Operational alerts (server-only, never VITE_/NEXT_PUBLIC_) ────────────────
// Used exclusively by api/_ai-gateway/alerts.ts to e-mail an administrator when
// an external provider (OpenAI / Azure Speech / …) starts failing. Every getter
// returns '' when unset; the alert module treats any missing value as "alerting
// not configured" and fails safe — it logs a sanitized line and never throws,
// so the user-facing request is never affected.

/** Resend API key. Empty string when unset → alert e-mails are skipped
 *  (only a sanitized log line is emitted), never an error. */
export function getResendApiKey(): string {
  return readEnv('RESEND_API_KEY');
}

/** Administrator recipient for operational alerts. Empty string when unset →
 *  alert e-mails are skipped. Never hardcode a personal address in code. */
export function getAlertRecipientEmail(): string {
  return readEnv('ALERT_RECIPIENT_EMAIL');
}

/** From address for operational alerts. Falls back to a neutral default on a
 *  verified sending domain; override per environment via ALERT_FROM_EMAIL. */
export function getAlertFromEmail(): string {
  return readEnv('ALERT_FROM_EMAIL') || 'alerts@orodim.com.br';
}

// ── Behavioral push (server-only OneSignal sending — never VITE_/NEXT_PUBLIC_) ─
// Used exclusively by api/_push/* to send behaviour-triggered push (streak_risk
// / abandonment) via the OneSignal REST API from the backend. The client SDK
// integration (src/lib/push/onesignalClient.ts) is unrelated and never sees any
// of these. Every getter returns '' / false when unset; the send path FAILS
// CLOSED (no fallback to the public client App ID, never sends without an
// explicit REST key + explicit enable flag).

/** OneSignal App ID the SERVER targets. Explicit and required for sending —
 *  there is intentionally NO fallback to the public client App ID constant in
 *  onesignalClient.ts. Empty string when unset → the sweep records rows but
 *  never calls OneSignal. */
export function getOneSignalServerAppId(): string {
  return readEnv('ONESIGNAL_APP_ID');
}

/** OneSignal REST API key — the secret that AUTHORIZES sending. SERVER-ONLY,
 *  never a VITE_ var, never logged, never returned by any endpoint. Empty
 *  string when unset → the send path fails closed and no push is dispatched. */
export function getOneSignalRestApiKey(): string {
  return readEnv('ONESIGNAL_REST_API_KEY');
}

/** Master switch for REAL behavioral-push sends. Only the exact string 'true'
 *  enables sending; anything else (unset/false/typo) leaves the sweep in
 *  dry-run — it evaluates eligibility and records rows but calls no provider. */
export function isBehavioralPushEnabled(): boolean {
  return readEnv('BEHAVIORAL_PUSH_ENABLED').toLowerCase() === 'true';
}

/** Force dry-run even when BEHAVIORAL_PUSH_ENABLED=true. Lets homologation
 *  validate eligibility/copy/cooldown/idempotency with zero real sends. */
export function isBehavioralPushDryRun(): boolean {
  return readEnv('BEHAVIORAL_PUSH_DRY_RUN').toLowerCase() === 'true';
}

/** Comma-separated Supabase UUIDs allowed to receive a REAL behavioral push.
 *  When NON-EMPTY (the homologation test setup), every other eligible user is
 *  recorded as dry_run instead of sent — so a homolog sweep can never blast the
 *  whole environment. Empty set (production) means no allowlist restriction.
 *  Case-insensitive. */
export function getBehavioralPushTestUserIds(): Set<string> {
  return new Set(
    readEnv('BEHAVIORAL_PUSH_TEST_USER_IDS')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

/** Authoritative environment label stored on every behavioral_push_events row
 *  and used for observability. REQUIRED on homologation (set
 *  BEHAVIORAL_PUSH_ENVIRONMENT=homologation) because that project also runs
 *  with VERCEL_ENV='production' (see getAlertEnvironmentOverride). When empty,
 *  falls back to the VERCEL_ENV mapping. */
export function getBehavioralPushEnvironment(): string {
  const override = readEnv('BEHAVIORAL_PUSH_ENVIRONMENT').toLowerCase();
  if (override) return override;
  return readEnv('VERCEL_ENV').toLowerCase() === 'production' ? 'production' : 'homologation';
}

/**
 * Authoritative environment label for alerts, lowercased. REQUIRED on the
 * homologation Vercel project (set ALERT_ENVIRONMENT=homolog), because that
 * project is deployed with `vercel deploy --prod` (see .github/workflows/
 * homologation.yml) and therefore runs with VERCEL_ENV='production' too —
 * VERCEL_ENV alone cannot tell homologation apart from the real production
 * project. When set it wins; when empty, alerts fall back to the VERCEL_ENV
 * mapping (production → production, everything else → staging/HOMOLOG). */
export function getAlertEnvironmentOverride(): string {
  return readEnv('ALERT_ENVIRONMENT').toLowerCase();
}
