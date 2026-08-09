import type { OrodimCommercialPlanCode } from '../../domain/subscription/revenuecat-catalog';

/**
 * Orodim's own domain contracts for RevenueCat — revenueCatClient.ts never
 * lets a raw @revenuecat/purchases-capacitor type (PurchasesPackage,
 * CustomerInfo, PurchasesError, ...) leak past this module boundary. Callers
 * (the subscription screen) only ever see these.
 */

export interface OrodimProductOffering {
  /** RevenueCat package identifier (e.g. 'essential_monthly') — identical on
   *  the App Store and Play Store, so this is what the UI matches and
   *  purchases by. Never match on productId (Android appends ':basePlanId').
   *  See revenuecat-catalog.ts REVENUECAT_SUBSCRIPTION_PACKAGE_IDS. */
  packageId: string;
  /** Store product id exactly as the store returns it — Apple: bare id;
   *  Android: 'productId:basePlanId'. Matches plans.apple_product_id on iOS;
   *  kept for display/debug only, never for client-side matching. */
  productId: string;
  title: string;
  description: string;
  /** Already formatted with currency by the store (e.g. "R$ 34,90") — never
   *  reformat or recompute a price client-side. */
  priceFormatted: string;
}

export interface OrodimCustomerInfo {
  activeEntitlementIds: string[];
  /** Non-authoritative — see revenuecat-catalog.ts's planCodeForActiveEntitlements
   *  doc comment. Only for optimistic UI before the backend sync confirms it. */
  activePlanCode: OrodimCommercialPlanCode | null;
  /** Real management URL from the store, or null when none exists (e.g. no
   *  active subscription, or the platform doesn't provide one) — a screen
   *  must never show a "manage" affordance when this is null. */
  managementUrl: string | null;
}

export type OrodimPurchaseErrorCode =
  | 'user_cancelled'
  | 'already_purchased'
  | 'network_error'
  | 'not_configured'
  | 'unknown';

export interface OrodimPurchaseError {
  code: OrodimPurchaseErrorCode;
  message: string;
}

export interface OrodimPurchaseResult {
  ok: boolean;
  customerInfo: OrodimCustomerInfo | null;
  error: OrodimPurchaseError | null;
}
