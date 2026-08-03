import { isIOSApp, isPluginAvailable } from '../runtimeEnvironment';
import { planCodeForActiveEntitlements } from '../../domain/subscription/revenuecat-catalog';
import type {
  OrodimCustomerInfo,
  OrodimProductOffering,
  OrodimPurchaseError,
  OrodimPurchaseResult,
} from './revenueCatTypes';

/**
 * SINGLE entry point to @revenuecat/purchases-capacitor — no other file in
 * this codebase may import that package directly. Everything here is
 * iOS-only: Android is deliberately left unconfigured (no Google Play
 * product ids/key exist yet — see revenuecat-catalog.ts and the FASE 16
 * manual checklist), and the web build never touches the SDK at all (no
 * checkout on the website — see SubscriptionView.tsx).
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
  // Android intentionally excluded — see module doc comment.
  return isIOSApp && isPluginAvailable('Purchases');
}

let configured = false;
let identifiedUserId: string | null = null;
// Guards against overlapping configure()/logIn()/logOut() calls racing each
// other (e.g. a fast sign-out-then-sign-in) — every entry point below
// chains onto this promise instead of firing a second SDK call mid-flight.
let identityChain: Promise<void> = Promise.resolve();

/** Real Apple product ids from the last getOfferings() call, keyed for
 *  purchaseProduct() — never re-exposes the raw PurchasesPackage. */
const packageCache = new Map<string, unknown>();

function apiKey(): string | null {
  const key = (import.meta.env.VITE_REVENUECAT_APPLE_API_KEY as string | undefined)?.trim();
  return key && key.length > 0 ? key : null;
}

async function doSyncIdentity(userId: string | null): Promise<void> {
  if (!isRevenueCatSupported()) return;
  const key = apiKey();
  if (!key) {
    // Not a hard failure — a homolog/dev build without the key configured
    // yet must not crash the app. Purchases simply stay unavailable.
    console.warn('[revenueCat] VITE_REVENUECAT_APPLE_API_KEY not set — purchases unavailable this session');
    return;
  }

  const { Purchases } = await loadPurchases();

  if (!configured) {
    await Purchases.configure({ apiKey: key, appUserID: userId ?? undefined });
    configured = true;
    identifiedUserId = userId;
    return;
  }

  if (userId && userId !== identifiedUserId) {
    await Purchases.logIn({ appUserID: userId });
    identifiedUserId = userId;
  } else if (!userId && identifiedUserId) {
    await Purchases.logOut();
    identifiedUserId = null;
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
  if (!isRevenueCatSupported() || !configured) return [];
  const { Purchases } = await loadPurchases();
  const offerings = await Purchases.getOfferings();
  const current = offerings.current;
  if (!current) return [];

  packageCache.clear();
  return current.availablePackages.map((pkg: (typeof current.availablePackages)[number]) => {
    packageCache.set(pkg.product.identifier, pkg);
    return {
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
 * Purchases by Apple product id (looked up in the cache populated by the
 * last getOfferings() call — call getOfferings() first). Never disables a
 * caller's own double-click guard; this function itself does not debounce.
 */
export async function purchaseProduct(productId: string): Promise<OrodimPurchaseResult> {
  if (!isRevenueCatSupported() || !configured) {
    return { ok: false, customerInfo: null, error: { code: 'not_configured', message: 'Compras não estão disponíveis.' } };
  }
  const pkg = packageCache.get(productId);
  if (!pkg) {
    return { ok: false, customerInfo: null, error: { code: 'unknown', message: 'Produto não encontrado. Atualize e tente novamente.' } };
  }
  const { Purchases, PURCHASES_ERROR_CODE } = await loadPurchases();
  try {
    const result = await Purchases.purchasePackage({ aPackage: pkg as Parameters<typeof Purchases.purchasePackage>[0]['aPackage'] });
    return { ok: true, customerInfo: toOrodimCustomerInfo(result.customerInfo), error: null };
  } catch (err) {
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
}
