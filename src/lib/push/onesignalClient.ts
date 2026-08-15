import { isIOSApp, isAndroidApp, isPluginAvailable } from '../runtimeEnvironment';

/**
 * SINGLE entry point to @onesignal/capacitor-plugin — no other file in this
 * codebase may import that package directly. Push is a NATIVE-only concern
 * here: the plugin bridge exists only inside the Android/iOS Capacitor shell.
 * This app is remote-first (the WebView loads app.orodim.com.br — see
 * capacitor.config.ts), so this module rides in the deployed web bundle and
 * calls the native OneSignal bridge exactly the way revenueCatClient.ts calls
 * @revenuecat/purchases-capacitor. On the plain web (a browser tab) every
 * function below is an inert no-op and the SDK is never even imported.
 *
 * Identity: the OneSignal external_id is ALWAYS the authenticated Supabase
 * UUID (session.user.id), via syncOneSignalIdentity(userId), driven by the
 * same session the rest of the app already trusts (src/hooks/useAuth.ts) —
 * never an email, RevenueCat id, device id, or token. See
 * src/hooks/useOneSignalIdentitySync.ts for the wiring.
 *
 * Lifecycle contract (mirrors OneSignal's own):
 *   - initialize(appId) runs at most once per app session (idempotent).
 *   - login(uuid) / logout() switch the identified user; account switch just
 *     logs in with the new uuid (OneSignal migrates the device subscription).
 *   - Permission is NEVER requested automatically — initialize() does not show
 *     the OS prompt. promptPushPermission() is the only path to the prompt and
 *     must be triggered by an explicit product/UX action (see ETAPA 6).
 */

// Public, non-secret OneSignal App ID. It only names which OneSignal app the
// device registers against — it does NOT authorize sending (that needs the
// REST API key, which is never shipped to the client). Safe to inline. We
// still read the VITE_ env var first to match the pattern the other native
// SDKs use (see revenueCatClient.ts), falling back to this constant so push
// keeps working in builds where the env var was not wired.
const FALLBACK_APP_ID = 'f95f5d2b-0e8f-411c-8f15-0c976545ee0c';

// Capacitor JS name the native plugin registers under (registerPlugin(
// "OneSignalCapacitor") in @onesignal/capacitor-plugin, jsName on the iOS/
// Android bridge). Used purely to confirm the native bridge is present.
const PLUGIN_NAME = 'OneSignalCapacitor';

// Verbose native logging is a development aid only — never in production, so a
// shipped app doesn't spam LogCat/Xcode. import.meta.env.DEV is true under
// `vite dev`/vitest and false in any production build.
const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

function resolveAppId(): string {
  const fromEnv = (import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined)?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : FALLBACK_APP_ID;
}

/** Sanitized, app-facing shape of a notification tap. Deliberately narrow: we
 *  never hand raw remote payload to navigation code (see ETAPA 10). */
export interface PushClickPayload {
  /** Action button id, when the tap was on a button rather than the body. */
  actionId: string | null;
  /** launchURL/url set on the OneSignal notification, if any. Not auto-opened. */
  url: string | null;
  /** OneSignal "Additional Data" custom key/value bag, if present. */
  additionalData: Record<string, unknown> | null;
}

export interface PushPermissionState {
  /** Whether push is even possible in this runtime (native + plugin present). */
  supported: boolean;
  /** The app currently has notification permission (incl. provisional/ephemeral). */
  hasPermission: boolean;
  /** Requesting permission would still surface a prompt (not yet asked). */
  canRequest: boolean;
}

// Lazy/dynamic import so the SDK's native bridge module is never evaluated in
// the web bundle's eager graph — isOneSignalSupported() already guards every
// call site, this just keeps the import out of the browser build entirely.
async function loadOneSignal() {
  const mod = await import('@onesignal/capacitor-plugin');
  return { OneSignal: mod.default, LogLevel: mod.LogLevel };
}

export function isOneSignalSupported(): boolean {
  return (isIOSApp || isAndroidApp) && isPluginAvailable(PLUGIN_NAME);
}

let initialized = false;
// In-flight initialize() promise — collapses the burst of calls a React
// StrictMode double-mount (or bootstrap + first identity sync racing) would
// otherwise make into a single OneSignal.initialize().
let initializing: Promise<boolean> | null = null;
let identifiedUserId: string | null = null;
// Serializes configure/login/logout so a fast sign-out-then-sign-in can't fire
// two overlapping SDK identity calls (same guard revenueCatClient.ts uses).
let identityChain: Promise<void> = Promise.resolve();
let listenersRegistered = false;
let clickHandler: ((payload: PushClickPayload) => void) | null = null;

/**
 * Register (or clear, with null) the single app-level handler for notification
 * taps. The native 'click' listener is registered once inside initialize();
 * it forwards a *sanitized* payload here so routing stays in one place and
 * reuses the app's own navigation instead of a second router. Kept a plain
 * setter (not an add/remove list) on purpose — there is exactly one router.
 */
export function setNotificationClickHandler(
  handler: ((payload: PushClickPayload) => void) | null,
): void {
  clickHandler = handler;
}

function sanitizeClick(event: unknown): PushClickPayload {
  const e = (event ?? {}) as {
    result?: { actionId?: unknown; url?: unknown };
    notification?: { additionalData?: unknown; launchURL?: unknown };
  };
  const result = e.result ?? {};
  const notification = e.notification ?? {};
  const url =
    typeof result.url === 'string'
      ? result.url
      : typeof notification.launchURL === 'string'
        ? notification.launchURL
        : null;
  const additionalData =
    notification.additionalData && typeof notification.additionalData === 'object'
      ? (notification.additionalData as Record<string, unknown>)
      : null;
  return {
    actionId: typeof result.actionId === 'string' ? result.actionId : null,
    url,
    additionalData,
  };
}

function registerListeners(
  OneSignal: Awaited<ReturnType<typeof loadOneSignal>>['OneSignal'],
): void {
  if (listenersRegistered) return;
  // Registered exactly once. The plugin captures cold-start launch options
  // natively (OSCapacitorLaunchOptions), so a tap that launched the app from
  // a killed state is still delivered here after initialize().
  OneSignal.Notifications.addEventListener('click', (event) => {
    try {
      const payload = sanitizeClick(event);
      if (isDev) console.info('[oneSignal] notification click', payload);
      // We intentionally do NOT open payload.url ourselves — no arbitrary
      // remote-driven navigation (ETAPA 10). The app-registered handler
      // decides, using the same validated navigation the rest of the app uses.
      clickHandler?.(payload);
    } catch (err) {
      console.warn('[oneSignal] click handler threw', err instanceof Error ? err.message : err);
    }
  });
  listenersRegistered = true;
}

/**
 * Initialize the OneSignal SDK once for this app session. Native-only,
 * idempotent, and — importantly — does NOT prompt for notification
 * permission. Safe to call repeatedly (bootstrap + every identity sync);
 * overlapping calls share one in-flight initialize(). A failure never throws
 * to the caller (bootstrap must not crash) — it resolves false and stays
 * retryable.
 */
export function initializeOneSignal(): Promise<boolean> {
  if (!isOneSignalSupported()) return Promise.resolve(false);
  if (initialized) return Promise.resolve(true);
  if (initializing) return initializing;

  initializing = (async () => {
    try {
      const { OneSignal, LogLevel } = await loadOneSignal();
      if (isDev) {
        try {
          OneSignal.Debug.setLogLevel(LogLevel.Verbose);
        } catch {
          /* Debug logging is best-effort; never let it block init. */
        }
      }
      await OneSignal.initialize(resolveAppId());
      registerListeners(OneSignal);
      initialized = true;
      return true;
    } catch (err) {
      console.warn('[oneSignal] initialize failed', err instanceof Error ? err.message : err);
      return false;
    } finally {
      initializing = null;
    }
  })();

  return initializing;
}

async function doSyncIdentity(userId: string | null): Promise<void> {
  if (!isOneSignalSupported()) return;
  const ready = await initializeOneSignal();
  if (!ready) return;

  const { OneSignal } = await loadOneSignal();

  if (userId && userId !== identifiedUserId) {
    // Covers first login AND account switch: OneSignal.login migrates the
    // current device subscription to this external_id, detaching it from the
    // previous user in the same call. Never called with an unknown/anon id.
    await OneSignal.login(userId);
    identifiedUserId = userId;
  } else if (!userId && identifiedUserId) {
    // Sign-out: unbind the device from the user. The device keeps its own
    // subscription (a new device-scoped anonymous user), it's just no longer
    // addressable by that Supabase UUID.
    await OneSignal.logout();
    identifiedUserId = null;
  }
}

/**
 * Call whenever the Supabase auth session changes (signed in, switched user,
 * or signed out) — see useOneSignalIdentitySync.ts. Pass the authoritative
 * session.user.id, or null when there is no session. Safe to call redundantly
 * with the same id (no-ops past the first). Never rejects.
 */
export function syncOneSignalIdentity(userId: string | null): Promise<void> {
  identityChain = identityChain
    .then(() => doSyncIdentity(userId))
    .catch((err) => {
      console.warn('[oneSignal] syncIdentity failed', err instanceof Error ? err.message : err);
    });
  return identityChain;
}

/**
 * Current push-permission snapshot for building an in-app "enable
 * notifications" affordance. Never triggers a prompt. Resolves a safe,
 * all-false state on web/unsupported or before initialize().
 */
export async function getPushPermissionState(): Promise<PushPermissionState> {
  const supported = isOneSignalSupported();
  if (!supported || !initialized) {
    return { supported, hasPermission: false, canRequest: false };
  }
  try {
    const { OneSignal } = await loadOneSignal();
    const [hasPermission, canRequest] = await Promise.all([
      OneSignal.Notifications.hasPermission(),
      OneSignal.Notifications.canRequestPermission(),
    ]);
    return { supported: true, hasPermission, canRequest };
  } catch (err) {
    console.warn('[oneSignal] getPushPermissionState failed', err instanceof Error ? err.message : err);
    return { supported: true, hasPermission: false, canRequest: false };
  }
}

/**
 * Explicitly prompt for notification permission — the ONLY path that shows the
 * OS prompt. Must be wired to a deliberate product/UX moment (soft-ask,
 * onboarding step, settings toggle), never fired at cold start (ETAPA 6).
 * fallbackToSettings=true sends an already-denied user to the system settings
 * instead of silently no-oping. Returns whether permission is granted; false
 * on web/unsupported or on error.
 */
export async function promptPushPermission(fallbackToSettings = true): Promise<boolean> {
  if (!isOneSignalSupported()) return false;
  const ready = await initializeOneSignal();
  if (!ready) return false;
  try {
    const { OneSignal } = await loadOneSignal();
    return await OneSignal.Notifications.requestPermission(fallbackToSettings);
  } catch (err) {
    console.warn('[oneSignal] requestPermission failed', err instanceof Error ? err.message : err);
    return false;
  }
}

/** True once initialize() has completed for this app session. */
export function isOneSignalInitialized(): boolean {
  return initialized;
}

// Test-only reset — never called from application code.
export function __resetOneSignalClientForTests(): void {
  initialized = false;
  initializing = null;
  identifiedUserId = null;
  identityChain = Promise.resolve();
  listenersRegistered = false;
  clickHandler = null;
}
