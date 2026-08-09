/**
 * Client-facing RevenueCat product/entitlement catalog — the ONE place the
 * app's own Apple product ids and RevenueCat entitlement ids are named.
 * Never duplicate these strings in a component or in src/lib/revenueCat/.
 *
 * Two separate identifier namespaces meet here, on purpose:
 *   - RevenueCat entitlement ids ('essential' | 'plus') — configured by a
 *     human in the RevenueCat dashboard (see the manual checklist in this
 *     task's final report). English, RevenueCat's own namespace.
 *   - Orodim's own plans.code ('essencial' | 'plus') — the database's plan
 *     identifier, Portuguese, already used everywhere else in this codebase
 *     (see supabase/migrations/20260727230600_essencial_plus_commercial_plans.sql).
 * This module is the only place that bridges them. It is NEVER the source
 * of truth for which plan a real product id maps to server-side — the
 * backend (api/_billing/revenuecat-subscription-sync-service.ts) always
 * looks that up by querying plans.apple_product_id directly (per this
 * task's own instruction: "localizar os planos pelo Apple Product ID já
 * salvo no banco, preferencialmente sem depender apenas do nome"), so a
 * product id added in the dashboard later works without a code deploy. This
 * file exists only for the CLIENT, which has no direct DB access and needs
 * to know, synchronously, which Offerings/packages to present and which
 * RevenueCat entitlement ids to treat as "this purchase succeeded" for its
 * own (non-authoritative) UI state — the backend/server truth from
 * GET /api/subscription/status is what actually gates the four activities.
 */

/** Real Apple subscription product ids, already saved in plans.apple_product_id
 *  (essencial/plus) — see ETAPA 1 audit of ahszqexfzpbirdlkmdci. */
export const REVENUECAT_SUBSCRIPTION_PRODUCT_IDS = {
  essencial: 'orodim.subscription.essential.monthly',
  plus: 'orodim.subscription.plus.monthly',
} as const;

/** Real Apple consumable product ids, already saved in
 *  conversation_minute_packages.apple_product_id. */
export const REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS = {
  'pacote-300-min': 'orodim.conversation.minutes.300',
  'pacote-600-min': 'orodim.conversation.minutes.600',
  'pacote-900-min': 'orodim.conversation.minutes.900',
} as const;

export type OrodimCommercialPlanCode = 'essencial' | 'plus';

/**
 * RevenueCat *package* identifiers in the `default` offering — the ONE key the
 * client uses to find/purchase a product, because it is identical across the
 * App Store and Play Store. The store *product* id is NOT safe to match on:
 * on Android RevenueCat appends the base-plan id (e.g.
 * `orodim.subscription.essential.monthly:monthly`), so matching by product id
 * silently fails there. Package ids are configured by a human in the
 * RevenueCat dashboard and must match these exactly.
 */
export const REVENUECAT_SUBSCRIPTION_PACKAGE_IDS: Record<OrodimCommercialPlanCode, string> = {
  essencial: 'essential_monthly',
  plus: 'plus_monthly',
};

/** RevenueCat package identifiers for the consumable minute packs (same on
 *  both stores — see REVENUECAT_SUBSCRIPTION_PACKAGE_IDS). */
export const REVENUECAT_MINUTE_PACKAGE_IDS = {
  'pacote-300-min': 'minutes_300',
  'pacote-600-min': 'minutes_600',
  'pacote-900-min': 'minutes_900',
} as const;

/** RevenueCat entitlement ids — must be created manually in the RevenueCat
 *  dashboard (see this task's final-report checklist) with exactly these
 *  identifiers, each granted by its matching subscription product above. */
export const REVENUECAT_ENTITLEMENT_IDS: Record<OrodimCommercialPlanCode, string> = {
  essencial: 'essential',
  plus: 'plus',
};

/**
 * Client-side only, non-authoritative: given the set of entitlement ids
 * RevenueCat's CustomerInfo currently reports as active, which Orodim plan
 * (if any) does that correspond to — used only to decide what the native
 * purchase UI shows optimistically before the backend sync round-trip
 * confirms it. Essencial never implies Plus and vice versa (each
 * entitlement is granted by exactly one subscription product — see the
 * module doc comment). Never used to grant access on its own.
 */
export function planCodeForActiveEntitlements(activeEntitlementIds: readonly string[]): OrodimCommercialPlanCode | null {
  const activeSet = new Set(activeEntitlementIds);
  if (activeSet.has(REVENUECAT_ENTITLEMENT_IDS.plus)) return 'plus';
  if (activeSet.has(REVENUECAT_ENTITLEMENT_IDS.essencial)) return 'essencial';
  return null;
}

export function isMinutePackageProductId(productId: string): boolean {
  return (Object.values(REVENUECAT_MINUTE_PACKAGE_PRODUCT_IDS) as readonly string[]).includes(productId);
}
