import { isIOSApp, isAndroidApp, isPluginAvailable } from '../runtimeEnvironment';
import { planCodeForActiveEntitlements } from '../../domain/subscription/revenuecat-catalog';
import type {
  OrodimCustomerInfo,
  OrodimPlanChange,
  OrodimProductOffering,
  OrodimPurchaseError,
  OrodimPurchaseResult,
} from './revenueCatTypes';

/**
 * SINGLE entry point to @revenuecat/purchases-capacitor — no other file in
 * this codebase may import that package directly. Supported on native iOS
 * (Apple key) and native Android (Google Play key) only; the web build
 * never touches the SDK at all (no checkout on the website — see
 * SubscriptionView.tsx). Both stores have their products/offerings
 * configured under the `default` offering; getOfferings() returns whichever
 * store the running native app belongs to. Callers match/purchase by the
 * RevenueCat package identifier (store-agnostic), never by the store product
 * id — Android appends the base-plan id to product ids (see
 * OrodimProductOffering / revenuecat-catalog.ts).
 *
 * Identity: the RevenueCat App User ID is always the authenticated Supabase
 * UUID, via syncIdentity(userId), driven by the same session the rest of
 * the app already trusts (src/hooks/useAuth.ts) — never an email, never a
 * permanently-anonymous id. configure() runs at most once per app session;
 * every subsequent identity change goes through logIn/logOut, matching
 * RevenueCat's own contract (calling configure() again is a mistake, not a
 * no-op).
 */

// Lazy/dynamic import so the SDK's native bridge code is never evaluated on
// web or Android — Capacitor.isPluginAvailable already guards every call
// site below, but this also keeps the import out of the web bundle's
// eagerly-evaluated module graph.
async function loadPurchases() {
  const mod = await import('@revenuecat/purchases-capacitor');
  return mod;
}

export function isRevenueCatSupported(): boolean {
  return (isIOSApp || isAndroidApp) && isPluginAvailable('Purchases');
}

let configured = false;
let identifiedUserId: string | null = null;
// Guards against overlapping configure()/logIn()/logOut() calls racing each
// other (e.g. a fast sign-out-then-sign-in) — every entry point below
// chains onto this promise instead of firing a second SDK call mid-flight.
let identityChain: Promise<void> = Promise.resolve();

/** Packages from the last getOfferings() call, keyed by RevenueCat package
 *  identifier (store-agnostic — e.g. 'essential_monthly') for purchasePackage()
 *  — never re-exposes the raw PurchasesPackage. */
const packageCache = new Map<string, unknown>();

/** Listeners notified whenever the SDK reaches (or changes) a usable identified
 *  state — after configure() completes, or after a logIn/logOut. This is how a
 *  screen reloads offerings once the SDK is actually ready, instead of polling
 *  or leaving an empty list from a getOfferings() that raced the initial
 *  syncIdentity(UUID). See useNativeSubscriptionPurchase.ts. */
const readyListeners = new Set<() => void>();

function notifyReady(): void {
  for (const listener of readyListeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[revenueCat] ready listener threw', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Subscribe to RevenueCat readiness/identity changes — the callback fires
 * after configure() finishes and after every subsequent logIn/logOut, i.e.
 * exactly when re-reading offerings can succeed. Never fires on web/unsupported
 * (the SDK is never configured there). Returns an unsubscribe function; safe to
 * register before the SDK is ready (you just get the next transition).
 */
export function subscribeReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

/** True once configure() has completed for this app session — i.e. offerings
 *  and purchases are actually usable. Lets a caller decide whether to await
 *  readiness (via subscribeReady) before its first offerings load. */
export function isRevenueCatConfigured(): boolean {
  return configured;
}

/** Name only — used for the "key not set" warning below, never for lookup
 *  (the actual read stays a static `import.meta.env.VITE_X` member access
 *  per platform so Vite can statically inline/tree-shake it). */
function apiKeyEnvVarName(): string {
  return isAndroidApp ? 'VITE_REVENUECAT_GOOGLE_API_KEY' : 'VITE_REVENUECAT_APPLE_API_KEY';
}

function apiKey(): string | null {
  const raw = isAndroidApp
    ? (import.meta.env.VITE_REVENUECAT_GOOGLE_API_KEY as string | undefined)
    : (import.meta.env.VITE_REVENUECAT_APPLE_API_KEY as string | undefined);
  const key = raw?.trim();
  return key && key.length > 0 ? key : null;
}

async function doSyncIdentity(userId: string | null): Promise<void> {
  if (!isRevenueCatSupported()) return;

  if (!configured && !userId) {
    // Never configure anonymously — the RevenueCat App User ID is always a
    // real Supabase UUID (see the module doc comment). This branch is hit
    // on cold app start, where useRevenueCatIdentitySync fires once before
    // useAuth() has resolved a session (userId is undefined/null then).
    // Nothing to do yet — the SDK isn't even imported — until this is
    // called again with a real userId once auth resolves.
    return;
  }

  const key = apiKey();
  if (!key) {
    // Not a hard failure — a homolog/dev build without the key configured
    // yet must not crash the app. Purchases simply stay unavailable. This is
    // the expected state for Android until the app is connected to
    // RevenueCat post-first-upload (see the module doc comment).
    console.warn(`[revenueCat] ${apiKeyEnvVarName()} not set — purchases unavailable this session`);
    return;
  }

  const { Purchases } = await loadPurchases();

  if (!configured) {
    // userId is guaranteed non-null here (the early-return above handles
    // the only case where it wouldn't be) — never appUserID: undefined.
    await Purchases.configure({ apiKey: key, appUserID: userId as string });
    configured = true;
    identifiedUserId = userId;
    // The SDK is now usable — wake any screen waiting to load offerings so it
    // never sits on the empty list a pre-configure getOfferings() returned.
    notifyReady();
    return;
  }

  if (userId && userId !== identifiedUserId) {
    await Purchases.logIn({ appUserID: userId });
    identifiedUserId = userId;
    // Offerings are per-identity — a screen must reload after a user switch.
    notifyReady();
  } else if (!userId && identifiedUserId) {
    await Purchases.logOut();
    identifiedUserId = null;
    notifyReady();
  }
}

/**
 * Call whenever the Supabase auth session changes (signed in with a
 * different user, or signed out) — see useRevenueCatIdentitySync.ts. Safe
 * to call redundantly with the same userId (no-ops past the first call).
 */
export function syncIdentity(userId: string | null): Promise<void> {
  identityChain = identityChain.then(() => doSyncIdentity(userId)).catch((err) => {
    console.warn('[revenueCat] syncIdentity failed', err instanceof Error ? err.message : err);
  });
  return identityChain;
}

function toOrodimCustomerInfo(customerInfo: {
  entitlements: { active: Record<string, unknown> };
  managementURL: string | null;
}): OrodimCustomerInfo {
  const activeEntitlementIds = Object.keys(customerInfo.entitlements.active);
  return {
    activeEntitlementIds,
    activePlanCode: planCodeForActiveEntitlements(activeEntitlementIds),
    managementUrl: customerInfo.managementURL,
  };
}

export async function getCustomerInfo(): Promise<OrodimCustomerInfo | null> {
  if (!isRevenueCatSupported() || !configured) return null;
  const { Purchases } = await loadPurchases();
  const { customerInfo } = await Purchases.getCustomerInfo();
  return toOrodimCustomerInfo(customerInfo);
}

/** Fires on every CustomerInfo change (purchase, renewal, restore reflected
 *  from the store, etc.) while the app is running. Registered at most once. */
let listenerRegistered = false;
export async function addCustomerInfoListener(onUpdate: (info: OrodimCustomerInfo) => void): Promise<void> {
  if (!isRevenueCatSupported() || listenerRegistered) return;
  const { Purchases } = await loadPurchases();
  await Purchases.addCustomerInfoUpdateListener((customerInfo) => onUpdate(toOrodimCustomerInfo(customerInfo)));
  listenerRegistered = true;
}

export async function getOfferings(): Promise<OrodimProductOffering[]> {
  if (!isRevenueCatSupported()) return [];
  // Wait for any in-flight configure()/logIn()/logOut() to settle first, so a
  // screen that mounted mid-syncIdentity doesn't read an unconfigured SDK and
  // cache an empty list — the race that surfaced "Produto não encontrado".
  await identityChain;
  if (!configured) return [];
  const { Purchases } = await loadPurchases();
  const offerings = await Purchases.getOfferings();
  const current = offerings.current;
  if (!current) return [];

  packageCache.clear();
  return current.availablePackages.map((pkg: (typeof current.availablePackages)[number]) => {
    packageCache.set(pkg.identifier, pkg);
    return {
      packageId: pkg.identifier,
      productId: pkg.product.identifier,
      title: pkg.product.title,
      description: pkg.product.description,
      priceFormatted: pkg.product.priceString,
    };
  });
}

function normalizePurchaseError(err: unknown, errorCodes: Record<string, string>): OrodimPurchaseError {
  const e = err as { code?: string; userCancelled?: boolean; message?: string } | undefined;
  if (e?.userCancelled || e?.code === errorCodes.PURCHASE_CANCELLED_ERROR) {
    return { code: 'user_cancelled', message: 'Compra cancelada.' };
  }
  if (e?.code === errorCodes.PRODUCT_ALREADY_PURCHASED_ERROR) {
    return { code: 'already_purchased', message: 'Você já possui este produto.' };
  }
  if (e?.code === errorCodes.NETWORK_ERROR) {
    return { code: 'network_error', message: 'Falha de conexão. Tente novamente.' };
  }
  return { code: 'unknown', message: 'Não foi possível concluir a compra. Tente novamente.' };
}

/**
 * Purchases by RevenueCat package identifier (looked up in the cache
 * populated by the last getOfferings() call — call getOfferings() first).
 * Package ids are the same on both stores, so this works identically on iOS
 * and Android (unlike the store product id — see OrodimProductOffering).
 * Never disables a caller's own double-click guard; this function itself does
 * not debounce.
 *
 * When `change` is provided this is a plan CHANGE (upgrade/downgrade), not a
 * first purchase. On Android it sends storeProductChangeInfo so Google Play
 * REPLACES the current subscription (never a second parallel one):
 *   - upgrade   → CHARGE_PRORATED_PRICE (immediate; the billing cycle is kept
 *                 and the prorated price for the remaining period is charged —
 *                 upgrade-only replacement mode)
 *   - downgrade → DEFERRED (takes effect at the next renewal)
 * On iOS the change info is intentionally omitted — the App Store handles
 * upgrade/downgrade within the subscription group when you simply purchase the
 * new package (both products must be in the same group, an App Store Connect
 * setting). The RevenueCat package identifier is still store-agnostic.
 */
export async function purchasePackage(packageId: string, change?: OrodimPlanChange): Promise<OrodimPurchaseResult> {
  // Settle any in-flight identity sync before deciding we're not configured —
  // a purchase tapped moments after the screen opened must not lose the race.
  await identityChain;
  if (!isRevenueCatSupported() || !configured) {
    return { ok: false, customerInfo: null, error: { code: 'not_configured', message: 'Compras não estão disponíveis.' } };
  }
  let pkg = packageCache.get(packageId);
  if (!pkg) {
    // The cache can be legitimately empty if offerings hadn't finished loading
    // when the screen mounted. Do exactly ONE safe refresh (never a retry
    // loop) before giving up — a refresh failure just falls through to
    // product_not_found, never crashes the purchase.
    try {
      await getOfferings();
    } catch (err) {
      console.warn('[revenueCat] offerings refresh before purchase failed', err instanceof Error ? err.message : err);
    }
    pkg = packageCache.get(packageId);
  }
  if (!pkg) {
    return { ok: false, customerInfo: null, error: { code: 'product_not_found', message: 'Produto não encontrado. Atualize e tente novamente.' } };
  }
  const { Purchases, PURCHASES_ERROR_CODE } = await loadPurchases();
  try {
    const options: Record<string, unknown> = { aPackage: pkg };
    // Android-only replacement. On iOS we never send change info — the App
    // Store manages the switch within the subscription group on a plain
    // purchase of the new package (see the doc comment above).
    if (change && isAndroidApp) {
      options.storeProductChangeInfo = {
        oldProductIdentifier: change.oldProductId,
        // STORE_REPLACEMENT_MODE values are plain strings the native bridge
        // reads directly (see @revenuecat/purchases-typescript-internal-esm).
        replacementMode: change.mode === 'upgrade' ? 'CHARGE_PRORATED_PRICE' : 'DEFERRED',
      };
    }
    const result = await Purchases.purchasePackage(options as unknown as Parameters<typeof Purchases.purchasePackage>[0]);
    return { ok: true, customerInfo: toOrodimCustomerInfo(result.customerInfo), error: null };
  } catch (err) {
    // Structured, secret-free diagnostics so a plan-change failure is
    // debuggable beyond the friendly user message — captures the raw store
    // error and the exact replacement descriptor we sent (see FASE 5 of the
    // audit: "não aceitar 'unknown' sem extrair o erro nativo real"). Never
    // logs tokens/receipts — only ids, codes and messages.
    const e = err as { code?: string; message?: string; userCancelled?: boolean; underlyingErrorMessage?: string; readableErrorCode?: string } | undefined;
    if (!e?.userCancelled) {
      console.warn('[revenueCat] purchasePackage failed', {
        packageId,
        isChange: Boolean(change),
        oldProductIdentifier: change?.oldProductId ?? null,
        replacementMode: change ? (change.mode === 'upgrade' ? 'CHARGE_PRORATED_PRICE' : 'DEFERRED') : null,
        code: e?.code ?? null,
        readableErrorCode: e?.readableErrorCode ?? null,
        message: e?.message ?? null,
        underlyingErrorMessage: e?.underlyingErrorMessage ?? null,
      });
    }
    return { ok: false, customerInfo: null, error: normalizePurchaseError(err, PURCHASES_ERROR_CODE as unknown as Record<string, string>) };
  }
}

/** Explicit user action only — never called automatically. */
export async function restorePurchases(): Promise<OrodimPurchaseResult> {
  if (!isRevenueCatSupported() || !configured) {
    return { ok: false, customerInfo: null, error: { code: 'not_configured', message: 'Restauração não está disponível.' } };
  }
  const { Purchases, PURCHASES_ERROR_CODE } = await loadPurchases();
  try {
    const { customerInfo } = await Purchases.restorePurchases();
    return { ok: true, customerInfo: toOrodimCustomerInfo(customerInfo), error: null };
  } catch (err) {
    return { ok: false, customerInfo: null, error: normalizePurchaseError(err, PURCHASES_ERROR_CODE as unknown as Record<string, string>) };
  }
}

/** Only ever a real store-returned URL (see OrodimCustomerInfo.managementUrl
 *  doc comment) — never a hardcoded generic App Store link. */
export async function getManagementUrl(): Promise<string | null> {
  const info = await getCustomerInfo();
  return info?.managementUrl ?? null;
}

// Test-only reset — never called from application code.
export function __resetRevenueCatClientForTests(): void {
  configured = false;
  identifiedUserId = null;
  identityChain = Promise.resolve();
  listenerRegistered = false;
  packageCache.clear();
  readyListeners.clear();
}
