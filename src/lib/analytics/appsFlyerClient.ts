import { isIOSApp, isAndroidApp, isPluginAvailable } from '../runtimeEnvironment';

/**
 * SINGLE entry point to appsflyer-capacitor-plugin — no other file in this
 * codebase may import that package directly. AppsFlyer is a NATIVE-only concern
 * here: the plugin bridge exists only inside the Android/iOS Capacitor shell.
 * This app is remote-first (the WebView loads app.orodim.com.br — see
 * capacitor.config.ts), so this module rides in the deployed web bundle and
 * calls the native AppsFlyer bridge exactly the way onesignalClient.ts calls
 * @onesignal/capacitor-plugin and revenueCatClient.ts calls
 * @revenuecat/purchases-capacitor. On the plain web (a browser tab) every
 * function below is an inert no-op and the SDK is never even imported — the web
 * app keeps working with zero attribution side effects.
 *
 * Scope (PHASE 1 — base integration only): initialize the SDK so install/open
 * is attributed, and keep the AppsFlyer Customer User ID in lockstep with the
 * Supabase session. NO in-app marketing events, RevenueCat→AppsFlyer revenue,
 * OneLink/deep linking, ad-partner or SKAN wiring — that is a later phase.
 *
 * Identity: the AppsFlyer Customer User ID is ALWAYS the authenticated Supabase
 * UUID (session.user.id) — no prefix, no transform, no separate marketing id —
 * so that Supabase UUID = AppsFlyer Customer User ID = RevenueCat App User ID.
 * Driven by the same session the rest of the app already trusts
 * (src/hooks/useAuth.ts); see src/hooks/useAppsFlyerIdentitySync.ts for the
 * wiring.
 *
 * Lifecycle contract (mirrors AppsFlyer's own):
 *   - initializeAppsFlyer() runs at most once per app session (idempotent), on
 *     app start, INDEPENDENT of whether anyone is signed in — install/open must
 *     be attributed before login. It auto-starts the SDK (no manualStart), and
 *     deliberately does NOT set waitForATTUserAuthorization: ATT is not
 *     implemented, so AppsFlyer starts immediately and works without IDFA.
 *   - setAppsFlyerCustomerUserId(uuid) attaches the Supabase UUID once auth
 *     resolves (session restore or login), and updates it on an account switch.
 *   - On sign-out we do NOTHING: AppsFlyer has no official "clear CUID" API, so
 *     we never invent an unset — the SDK keeps the last CUID until a different
 *     user logs in (see doSetCustomerUserId).
 */

// Capacitor JS name the native plugin registers under
// (registerPlugin('AppsFlyerPlugin', {}) in appsflyer-capacitor-plugin). Used
// purely to confirm the native bridge is present before any call.
const PLUGIN_NAME = 'AppsFlyerPlugin';

// iOS Apple App ID — numeric only, WITHOUT the "id" prefix the AppsFlyer
// dashboard shows (it lists "id6794127995"; the SDK wants "6794127995"). PUBLIC
// (it's the id in the App Store URL apps.apple.com/app/id6794127995), never a
// secret. Ignored by the Android SDK, which attributes by package name. We read
// the VITE_ env var first to match the other native SDKs (see onesignalClient's
// resolveAppId), falling back to this known value so iOS attribution keeps
// working in builds where the env var was not wired.
const FALLBACK_APP_ID = '6794127995';

/**
 * AppsFlyer's verbose native logging. Kept OFF in production unconditionally:
 * import.meta.env.DEV is true under `vite dev`/vitest and false in ANY
 * production build (`vite build`), and Vite inlines it as a literal — the
 * guarantee we rely on to keep AppsFlyer's verbose logging out of production
 * (task ETAPA 8). A homolog build MAY additionally opt into verbose logs by
 * setting VITE_APPSFLYER_DEBUG=true on its own Vercel project — the production
 * project never sets it, so production stays quiet. The dev key is never logged
 * regardless of this flag.
 */
function resolveDebug(): boolean {
  const dev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  const optIn = (import.meta.env.VITE_APPSFLYER_DEBUG as string | undefined)?.trim() === 'true';
  return dev || optIn;
}

function resolveAppId(): string {
  const fromEnv = (import.meta.env.VITE_APPSFLYER_APP_ID as string | undefined)?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : FALLBACK_APP_ID;
}

/** The AppsFlyer Dev Key. Unlike the OneSignal App ID / RevenueCat public keys,
 *  this is treated as sensitive: there is NO hardcoded fallback and it is never
 *  written to a log. A build without it wired stays fail-safe — the SDK is never
 *  initialized and attribution is simply disabled this session (no crash). Read
 *  as a static import.meta.env member access so Vite can inline it at build. */
function devKey(): string | null {
  const raw = import.meta.env.VITE_APPSFLYER_DEV_KEY as string | undefined;
  const key = raw?.trim();
  return key && key.length > 0 ? key : null;
}

// Lazy/dynamic import so the SDK's native bridge module is never evaluated in
// the web bundle's eager graph — isAppsFlyerSupported() already guards every
// call site, this just keeps the import out of the browser build entirely.
async function loadAppsFlyer() {
  const mod = await import('appsflyer-capacitor-plugin');
  return { AppsFlyer: mod.AppsFlyer };
}

export function isAppsFlyerSupported(): boolean {
  return (isIOSApp || isAndroidApp) && isPluginAvailable(PLUGIN_NAME);
}

let initialized = false;
// In-flight initSDK() promise — collapses the burst of calls a React StrictMode
// double-mount (or bootstrap + first identity sync racing) would otherwise make
// into a single AppsFlyer.initSDK().
let initializing: Promise<boolean> | null = null;
let identifiedUserId: string | null = null;
// Serializes the identity calls so a fast sign-out-then-sign-in can't fire two
// overlapping setCustomerUserId calls (same guard revenueCatClient.ts uses).
let identityChain: Promise<void> = Promise.resolve();

/**
 * Initialize the AppsFlyer SDK once for this app session. Native-only,
 * idempotent, and auto-starting (install/open is attributed immediately, before
 * any login). Safe to call repeatedly (bootstrap + every identity sync);
 * overlapping calls share one in-flight initSDK(). A failure never throws to the
 * caller (bootstrap must not crash) — it resolves false and stays retryable.
 * Resolves false (without importing the SDK) on web/unsupported or when the dev
 * key is not configured.
 */
export function initializeAppsFlyer(): Promise<boolean> {
  if (!isAppsFlyerSupported()) return Promise.resolve(false);
  if (initialized) return Promise.resolve(true);
  if (initializing) return initializing;

  initializing = (async () => {
    try {
      const key = devKey();
      if (!key) {
        // Fail-safe: a homolog/dev build without the dev key wired must not
        // crash. AppsFlyer simply stays inert until the key is set (Vercel env).
        // Never log the key itself — only that it is missing.
        console.warn('[appsFlyer] VITE_APPSFLYER_DEV_KEY not set — attribution disabled this session');
        return false;
      }
      const { AppsFlyer } = await loadAppsFlyer();
      await AppsFlyer.initSDK({
        devKey: key,
        appID: resolveAppId(),
        isDebug: resolveDebug(),
        // No manualStart → the SDK starts now, so install/open is registered
        // before login. No waitForATTUserAuthorization → we never block the
        // first session on an ATT prompt (ATT is not implemented; AppsFlyer
        // works without IDFA). See the module doc comment.
      });
      initialized = true;
      return true;
    } catch (err) {
      console.warn('[appsFlyer] initSDK failed', err instanceof Error ? err.message : err);
      return false;
    } finally {
      initializing = null;
    }
  })();

  return initializing;
}

async function doSetCustomerUserId(userId: string | null): Promise<void> {
  if (!isAppsFlyerSupported()) return;

  // Sign-out: AppsFlyer has no official "clear/unset CUID" API, so we
  // deliberately leave the last CUID in place rather than invent one. Keeping
  // identifiedUserId as-is also means a relogin by the SAME user is a no-op,
  // while a DIFFERENT user still triggers an update below.
  if (!userId) return;

  // Skip redundant setCustomerUserId calls for the id we already sent (cold-start
  // session restore re-fires the identity effect with the same uuid).
  if (userId === identifiedUserId) return;

  const ready = await initializeAppsFlyer();
  if (!ready) return;

  const { AppsFlyer } = await loadAppsFlyer();
  // Always the raw Supabase UUID — no prefix, no transform (see module doc).
  await AppsFlyer.setCustomerUserId({ cuid: userId });
  identifiedUserId = userId;
}

/**
 * Call whenever the Supabase auth session resolves or changes (session restore,
 * login, account switch, sign-out) — see useAppsFlyerIdentitySync.ts. Pass the
 * authoritative session.user.id, or null when there is no session. Safe to call
 * redundantly with the same id (no-ops past the first). Never rejects.
 */
export function setAppsFlyerCustomerUserId(userId: string | null): Promise<void> {
  identityChain = identityChain
    .then(() => doSetCustomerUserId(userId))
    .catch((err) => {
      console.warn('[appsFlyer] setCustomerUserId failed', err instanceof Error ? err.message : err);
    });
  return identityChain;
}

/** True once initSDK() has completed for this app session. */
export function isAppsFlyerInitialized(): boolean {
  return initialized;
}

// Test-only reset — never called from application code.
export function __resetAppsFlyerClientForTests(): void {
  initialized = false;
  initializing = null;
  identifiedUserId = null;
  identityChain = Promise.resolve();
}
